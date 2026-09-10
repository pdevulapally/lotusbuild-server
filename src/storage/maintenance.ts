import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { MeteringService } from '../metering/service.ts';
import { integerField, stringField } from '../support/documents.ts';
import type { SnapshotStore } from './snapshots.ts';

/** Durable, bounded cleanup. Every mutation is retryable after process death. */
export class SnapshotMaintenance {
  private readonly firestore: Firestore;
  private readonly metering: MeteringService;
  private readonly snapshots: SnapshotStore;
  constructor(firestore: Firestore, metering: MeteringService, snapshots: SnapshotStore) {
    this.firestore = firestore; this.metering = metering; this.snapshots = snapshots;
  }

  async sweep(): Promise<void> {
    const page = await this.firestore.collection('snapshotUploads')
      .where('status', 'in', ['CANDIDATE', 'OBSOLETE', 'CLEANING'])
      .where('expiresAt', '<=', Timestamp.now()).limit(100).get();
    const failures: unknown[] = [];
    for (const doc of page.docs) {
      try { await this.collect(doc.id, false); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Some snapshot cleanup jobs remain pending.');
  }

  async deleteProject(projectId: string): Promise<void> {
    for (;;) {
      const page = await this.firestore.collection('snapshotUploads').where('projectId', '==', projectId)
        .where('status', 'in', ['CANDIDATE', 'CURRENT', 'OBSOLETE', 'CLEANING']).limit(100).get();
      if (page.empty) return;
      for (const doc of page.docs) await this.collect(doc.id, true);
    }
  }

  private async collect(id: string, deletingProject: boolean): Promise<void> {
    const ref = this.firestore.doc(`snapshotUploads/${id}`);
    const claimed = await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const fields = snapshot.data();
      if (fields === undefined || fields['status'] === 'DELETED') return undefined;
      const projectId = stringField(fields, 'projectId', ref.path);
      const project = await tx.get(this.firestore.doc(`projects/${projectId}`));
      if (deletingProject) {
        if (project.data()?.['status'] !== 'deleting' || project.data()?.['activeSessionId'] !== null) throw new Error('Project deletion is not fenced.');
      } else if (fields['status'] === 'CURRENT' || project.data()?.['snapshotUploadId'] === id) return undefined;
      const charged = fields['charged'] === true || fields['status'] === 'CURRENT' || fields['status'] === 'OBSOLETE';
      tx.update(ref, { status: 'CLEANING', charged });
      return { ...fields, charged } as Record<string, unknown>;
    });
    if (claimed === undefined) return;
    const projectId = stringField(claimed, 'projectId', ref.path);
    if (claimed['legacy'] === true) await this.snapshots.removeStored(projectId, { kind: 'legacy' });
    else await this.snapshots.removeRetiredUpload(stringField(claimed, 'objectName', ref.path));
    await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const fields = snapshot.data() ?? {};
      if (fields['status'] === 'DELETED') return;
      if (fields['status'] !== 'CLEANING') throw new Error('Snapshot cleanup lost its claim.');
      const uid = stringField(fields, 'ownerUid', ref.path);
      if (fields['charged'] === true) await this.metering.removeStoredBytesIn(tx, uid, integerField(fields, 'bytes', ref.path, { min: 1 }));
      else await this.metering.releaseIn(tx, uid, [stringField(fields, 'reservationId', ref.path)], new Date());
      tx.update(ref, { status: 'DELETED', deletedAt: FieldValue.serverTimestamp(), ownerUid: FieldValue.delete(),
        leaseToken: FieldValue.delete(), reservationId: FieldValue.delete(), projectId: FieldValue.delete(), objectName: FieldValue.delete() });
    });
  }
}
