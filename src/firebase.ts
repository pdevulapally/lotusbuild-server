import { readFileSync } from 'node:fs';

import { type App, cert, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

import { EnvironmentError } from './config/env.ts';
import type { Config } from './config/index.ts';

/**
 * The service account lives in a file rather than an environment variable so the
 * private key is never visible in `docker inspect`, a crash dump or a shell's
 * process listing. The file is read once at boot and never held open.
 */
interface ServiceAccountFile {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

function readServiceAccount(path: string, expectedProjectId: string): ServiceAccountFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new EnvironmentError([
      `FIREBASE_SERVICE_ACCOUNT_FILE cannot be read at ${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvironmentError([`FIREBASE_SERVICE_ACCOUNT_FILE at ${path} is not valid JSON.`]);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvironmentError([`FIREBASE_SERVICE_ACCOUNT_FILE at ${path} is not a JSON object.`]);
  }

  const record = parsed as Record<string, unknown>;
  const missing = (['project_id', 'client_email', 'private_key'] as const).filter(
    (field) => typeof record[field] !== 'string' || (record[field] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new EnvironmentError(
      missing.map((field) => `FIREBASE_SERVICE_ACCOUNT_FILE at ${path} is missing "${field}".`),
    );
  }

  const account = record as unknown as ServiceAccountFile;

  // Deploying the wrong project's key is otherwise a runtime mystery: tokens
  // simply fail to verify with no indication that the credential is for a
  // different project entirely.
  if (account.project_id !== expectedProjectId) {
    throw new EnvironmentError([
      `FIREBASE_SERVICE_ACCOUNT_FILE at ${path} belongs to project "${account.project_id}", ` +
        `but FIREBASE_PROJECT_ID is "${expectedProjectId}".`,
    ]);
  }

  return account;
}

export interface FirebaseServices {
  readonly app: App;
  readonly auth: Auth;
  readonly firestore: Firestore;
}

/**
 * Initialises the Admin SDK from explicit credentials, once, for the whole
 * process. Application Default Credentials are deliberately not used: they
 * resolve from ambient state, so a misconfigured host silently authenticates as
 * something unexpected instead of failing.
 */
export function initialiseFirebase(config: Config): FirebaseServices {
  const account = readServiceAccount(
    config.FIREBASE_SERVICE_ACCOUNT_FILE,
    config.FIREBASE_PROJECT_ID,
  );

  const app = initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
    }),
    projectId: account.project_id,
  });

  const firestore = getFirestore(app);
  // Undefined is how an optional field is absent in TypeScript; without this the
  // driver throws on any object carrying one, which turns an ordinary optional
  // into a write failure at the worst moment.
  firestore.settings({ ignoreUndefinedProperties: true });

  return { app, auth: getAuth(app), firestore };
}
