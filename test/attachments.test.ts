import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

import { AttachmentRepository } from '../src/attachments/repository.ts';
import type { EntitlementService, UserEntitlements } from '../src/entitlements/service.ts';
import type { ConfigurationStore } from '../src/entitlements/store.ts';
import { MeteringService } from '../src/metering/service.ts';
import type { ProjectRepository } from '../src/projects/repository.ts';
import { userContentWithAttachments } from '../src/runner/agent.ts';
import type { AttachmentStorage } from '../src/storage/attachments.ts';
import { ledger } from './support/ledger.ts';

function fixture(options: { uploaded?: { bytes: number; contentType: string } } = {}) {
  const { db, data } = ledger();
  const configuration = { get: async () => ({ registry: { storageMeterKey: 'storage', meters: new Map([
    ['storage', { key: 'storage', label: 'Storage', unit: 'bytes', kind: 'GAUGE', resetPeriod: 'NEVER' }],
  ]) } }) } as unknown as ConfigurationStore;
  const metering = new MeteringService(db, configuration);
  const resolved = { planKey: 'test', planName: 'Test', meterLimits: new Map([
    ['storage', { meterKey: 'storage', hardLimit: 1000, includedAllowance: 1000, overageEnabled: false }],
  ]) } as unknown as UserEntitlements;
  const entitlements = { forUser: async () => resolved } as unknown as EntitlementService;
  const project = { id: 'p', ownerUid: 'u', platform: 'web' };
  const projects = {
    readOwned: async (uid: string, id: string) => { if (uid !== 'u' || id !== 'p') throw new Error('not found'); return project; },
    readOwnedInTransaction: async (_tx: unknown, uid: string, id: string) => { if (uid !== 'u' || id !== 'p') throw new Error('not found'); return project; },
  } as unknown as ProjectRepository;
  const retired: string[] = [];
  const storage: AttachmentStorage = {
    createUpload: async (objectName) => `https://storage.test/${objectName}?signed`,
    inspect: async () => { if (options.uploaded === undefined) throw new Error('404'); return { generation: '7', ...options.uploaded }; },
    read: async () => Buffer.from('hello'),
    retire: async (objectName) => { retired.push(objectName); },
  };
  const attachments = new AttachmentRepository(db as unknown as Firestore, projects, entitlements, metering, configuration, storage, 600);
  return { db, data, attachments, retired };
}

const usage = (data: Map<string, Record<string, unknown>>) => data.get('users/u/usage/storage') ?? {};

test('upload admission reserves bytes, completion charges them, and a message claims the file once', async () => {
  const h = fixture({ uploaded: { bytes: 300, contentType: 'image/png' } });
  const { attachment, uploadUrl } = await h.attachments.begin('u', 'p', { name: 'shot.png', contentType: 'image/png', bytes: 300 });
  assert.equal(uploadUrl, `https://storage.test/users/u/attachments/${attachment.id}?signed`);
  assert.equal(usage(h.data)['reserved'], 300);

  const ready = await h.attachments.complete('u', attachment.id);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.generation, '7');
  assert.equal(usage(h.data)['consumed'], 300);
  assert.equal(usage(h.data)['reserved'], 0);

  const claimed = await h.db.runTransaction((tx) => h.attachments.claimIn(tx as Transaction, 'u', 'p', [attachment.id]));
  assert.deepEqual(claimed, [{ id: attachment.id, name: 'shot.png', contentType: 'image/png', bytes: 300,
    objectName: `users/u/attachments/${attachment.id}`, generation: '7' }]);
  await assert.rejects(h.db.runTransaction((tx) => h.attachments.claimIn(tx as Transaction, 'u', 'p', [attachment.id])), { code: 'attachment/not-ready' });
  await assert.rejects(h.attachments.remove('u', attachment.id), { code: 'attachment/in-use' });
});

test('a file that was never uploaded, or whose bytes differ, cannot become READY', async () => {
  const missing = fixture();
  const { attachment } = await missing.attachments.begin('u', 'p', { name: 'notes.txt', contentType: 'text/plain', bytes: 10 });
  await assert.rejects(missing.attachments.complete('u', attachment.id), { code: 'attachment/not-uploaded' });

  const mismatched = fixture({ uploaded: { bytes: 11, contentType: 'text/plain' } });
  const second = await mismatched.attachments.begin('u', 'p', { name: 'notes.txt', contentType: 'text/plain', bytes: 10 });
  await assert.rejects(mismatched.attachments.complete('u', second.attachment.id), { code: 'attachment/upload-mismatch' });
});

test('another user or project never sees the attachment, and removal returns the bytes', async () => {
  const h = fixture({ uploaded: { bytes: 40, contentType: 'application/pdf' } });
  const { attachment } = await h.attachments.begin('u', 'p', { name: 'spec.pdf', contentType: 'application/pdf', bytes: 40 });
  await h.attachments.complete('u', attachment.id);
  await assert.rejects(h.attachments.complete('intruder', attachment.id), { code: 'attachment/not-found' });
  await assert.rejects(h.db.runTransaction((tx) => h.attachments.claimIn(tx as Transaction, 'u', 'other-project', [attachment.id])), { code: 'attachment/not-found' });
  await h.attachments.remove('u', attachment.id);
  assert.equal(usage(h.data)['consumed'], 0);
  assert.deepEqual(h.retired, [`users/u/attachments/${attachment.id}`]);
  assert.equal(h.data.get(`attachments/${attachment.id}`)?.['status'], 'RETIRED');
});

test('declared limits are enforced before any storage is touched', async () => {
  const h = fixture();
  await assert.rejects(h.attachments.begin('u', 'p', { name: 'x.exe', contentType: 'application/x-msdownload', bytes: 1 }), { code: 'attachment/unsupported-type' });
  await assert.rejects(h.attachments.begin('u', 'p', { name: '../x.png', contentType: 'image/png', bytes: 1 }), { code: 'attachment/invalid-name' });
  await assert.rejects(h.attachments.begin('u', 'p', { name: 'x.png', contentType: 'image/png', bytes: 11 * 1024 * 1024 }), { code: 'attachment/too-large' });
  assert.equal(h.data.size, 0);
  await assert.rejects(h.db.runTransaction((tx) => h.attachments.claimIn(tx as Transaction, 'u', 'p', ['a', 'a'])), { code: 'attachment/duplicate' });
});

test('attached files reach the model as typed content blocks, never as summaries', async () => {
  const read = async (attachment: { contentType: string }) =>
    attachment.contentType === 'text/plain' ? Buffer.from('plain words') : Buffer.from([1, 2, 3]);
  const blocks = await userContentWithAttachments('Look at these', [
    { id: 'a', name: 'shot.png', contentType: 'image/png', bytes: 3, objectName: 'o1', generation: '1' },
    { id: 'b', name: 'spec.pdf', contentType: 'application/pdf', bytes: 3, objectName: 'o2', generation: '1' },
    { id: 'c', name: 'notes.txt', contentType: 'text/plain', bytes: 11, objectName: 'o3', generation: '1' },
  ], read);
  assert.ok(Array.isArray(blocks));
  const kinds = blocks.map((block) => block.type);
  assert.deepEqual(kinds, ['text', 'text', 'image', 'text', 'document', 'text']);
  assert.deepEqual(blocks[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } });
  assert.ok((blocks[5] as { text: string }).text.endsWith('plain words'));
  assert.equal(await userContentWithAttachments('No files', [], read), 'No files');
});
