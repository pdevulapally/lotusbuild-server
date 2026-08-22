import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import type { AuthenticatedUser } from '../auth/plugin.ts';
import { AppError } from '../http/errors.ts';
import { type Fields, integerField, stringField } from '../support/documents.ts';

export const usersCollectionPath = 'users';

export interface UserRecord {
  readonly uid: string;
  readonly email: string;
  readonly displayName: string | undefined;
  readonly photoUrl: string | undefined;
  /**
   * Maintained transactionally alongside project creation. A limit enforced by
   * counting documents can be exceeded by two requests counting at the same
   * time, which is a paid limit that racing bypasses.
   */
  readonly projectCount: number;
}

function optionalString(fields: Fields, name: string): string | undefined {
  const value = fields[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function parseUser(fields: Fields, where: string): UserRecord {
  return {
    uid: stringField(fields, 'uid', where),
    email: stringField(fields, 'email', where),
    displayName: optionalString(fields, 'displayName'),
    photoUrl: optionalString(fields, 'photoUrl'),
    projectCount: integerField(fields, 'projectCount', where, { min: 0 }),
  };
}

export class UserRepository {
  readonly #firestore: Firestore;

  constructor(firestore: Firestore) {
    this.#firestore = firestore;
  }

  #ref(uid: string) {
    return this.#firestore.doc(`${usersCollectionPath}/${uid}`);
  }

  /**
   * Returns the stored user, creating it on first sight and refreshing the
   * profile only when the token actually disagrees with what is stored.
   *
   * The comparison matters: this runs on the session-start request, so writing
   * unconditionally would turn every returning user into a billed write for no
   * change.
   */
  async ensure(user: AuthenticatedUser): Promise<UserRecord> {
    const ref = this.#ref(user.uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      const created: UserRecord = {
        uid: user.uid,
        email: user.email ?? '',
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        projectCount: 0,
      };
      if (created.email === '') {
        // Every sign-in method this product supports carries an email. A user
        // without one would break ownership lookups and any future notification,
        // so it is refused rather than stored as a blank.
        throw new AppError({
          code: 'auth/email-required',
          statusCode: 403,
          message: 'This account has no email address, which this service requires.',
        });
      }
      await ref.create({
        ...created,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return created;
    }

    const stored = parseUser(snapshot.data() ?? {}, ref.path);
    const changed =
      (user.email !== undefined && user.email !== stored.email) ||
      user.displayName !== stored.displayName ||
      user.photoUrl !== stored.photoUrl;

    if (!changed) {
      return stored;
    }

    const refreshed: UserRecord = {
      ...stored,
      email: user.email ?? stored.email,
      displayName: user.displayName,
      photoUrl: user.photoUrl,
    };
    await ref.update({
      email: refreshed.email,
      displayName: refreshed.displayName ?? FieldValue.delete(),
      photoUrl: refreshed.photoUrl ?? FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return refreshed;
  }

  /**
   * Reads the user inside a transaction, for callers that then change a counter
   * on it. Absent is an error here: the caller is already authenticated, so a
   * missing record means `ensure` was never reached, not that the user is new.
   */
  async readInTransaction(transaction: Transaction, uid: string): Promise<UserRecord> {
    const ref = this.#ref(uid);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new AppError({
        code: 'user/not-initialised',
        statusCode: 409,
        message: 'This account has not been initialised. Call /me once before creating resources.',
      });
    }
    return parseUser(snapshot.data() ?? {}, ref.path);
  }

  refFor(uid: string) {
    return this.#ref(uid);
  }
}
