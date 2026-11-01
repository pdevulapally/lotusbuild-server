import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActionApprovals, ApprovalRejectedError, hashAction } from '../src/connections/approvals.ts';
import { OAuthStateError, OAuthStateStore, pkceChallenge } from '../src/connections/oauth.ts';
import { OperationAlreadyClaimedError, OperationLedger, ReconciliationRequiredError, StaleOperationLeaseError } from '../src/connections/operations.ts';
import { ledger } from './support/ledger.ts';

const base = { connectionId: 'conn-1', action: 'deploy', projectId: 'p1', destination: 'site-abc', requestFingerprint: 'sha256:abc', sessionId: 'sess-1', ownerUid: 'alice' };

const withProjects = () => {
  const store = ledger();
  store.data.set('projects/p1', { ownerUid: 'alice', status: 'draft' });
  return store;
};

describe('OperationLedger', () => {
  it('claims an operation once and refuses a second claim of the same id', async () => {
    const ops = new OperationLedger(ledger().db);
    const claimed = await ops.claim({ ...base, id: 'op-1' });
    assert.equal(claimed.record.status, 'claimed');
    assert.equal(typeof claimed.leaseToken, 'string');
    await assert.rejects(ops.claim({ ...base, id: 'op-1' }), OperationAlreadyClaimedError);
  });

  it('blocks the same action while an earlier operation is claimed or uncertain, until reconciled', async () => {
    const store = ledger();
    const ops = new OperationLedger(store.db);
    const { leaseToken } = await ops.claim({ ...base, id: 'op-1' });
    await assert.rejects(ops.claim({ ...base, id: 'op-2' }), ReconciliationRequiredError);
    await ops.recordProviderRef('op-1', leaseToken, 'dpl_123');
    await ops.settle('op-1', leaseToken, 'uncertain', 'response lost');
    await assert.rejects(ops.claim({ ...base, id: 'op-2' }), (error: unknown) =>
      error instanceof ReconciliationRequiredError && error.operationId === 'op-1');
    const [pending] = await ops.uncertain('conn-1');
    assert.equal(pending?.providerRef, 'dpl_123');
    assert.equal(pending?.destination, 'site-abc');
    await assert.rejects(ops.settle('op-1', leaseToken, 'succeeded'), StaleOperationLeaseError);
    assert.equal(store.data.get('connection_action_locks/conn-1__deploy')?.['activeOperationId'], 'op-1');
    await ops.reconcile('op-1', 'succeeded', { decidedBy: 'operator:preetham', outcome: 'found deployment dpl_123 READY' });
    await assert.rejects(ops.reconcile('op-1', 'failed', { decidedBy: 'operator:preetham', outcome: 'x' }), /not awaiting reconciliation/);
    const next = await ops.claim({ ...base, id: 'op-2' });
    assert.equal(next.record.id, 'op-2');
    const other = await ops.claim({ ...base, action: 'sites.read', id: 'op-3' });
    assert.equal(other.record.action, 'sites.read');
  });

  it('lets only the worker holding the lease settle; a stale worker cannot overwrite the outcome', async () => {
    const ops = new OperationLedger(ledger().db);
    const first = await ops.claim({ ...base, id: 'op-1' });
    await assert.rejects(ops.recordProviderRef('op-1', 'forged-token', 'dpl_x'), StaleOperationLeaseError);
    await assert.rejects(ops.settle('op-1', 'forged-token', 'failed'), StaleOperationLeaseError);
    await ops.settle('op-1', first.leaseToken, 'failed', 'provider 500');
    await assert.rejects(ops.settle('op-1', first.leaseToken, 'succeeded'), StaleOperationLeaseError);
    await assert.rejects(ops.reconcile('op-1', 'succeeded', { decidedBy: 'operator', outcome: 'x' }), /not awaiting reconciliation/);
    const second = await ops.claim({ ...base, id: 'op-2' });
    assert.notEqual(second.leaseToken, first.leaseToken);
  });

  it('turns a crashed worker\'s lapsed claim into an uncertain operation that can be reconciled, never silently unblocked', async () => {
    const store = ledger();
    const ops = new OperationLedger(store.db, 1000);
    const t0 = new Date('2026-10-31T20:00:00Z');
    const first = await ops.claim({ ...base, id: 'op-1' }, t0);
    const later = new Date(t0.getTime() + 1001);
    await assert.rejects(ops.settle('op-1', first.leaseToken, 'succeeded', undefined, later), StaleOperationLeaseError);
    await assert.rejects(ops.claim({ ...base, id: 'op-2' }, later), (e: unknown) => e instanceof ReconciliationRequiredError && e.operationId === 'op-1');
    assert.equal(store.data.get('connection_operations/op-1')?.['status'], 'uncertain');
    const [pending] = await ops.uncertain('conn-1');
    assert.match(pending?.outcome ?? '', /lease expired/);
    await ops.reconcile('op-1', 'failed', { decidedBy: 'provider-lookup', outcome: 'no deployment found' }, later);
    const next = await ops.claim({ ...base, id: 'op-2' }, later);
    assert.equal(next.record.id, 'op-2');
  });

  it('never lets two concurrent claims for the same action both commit', async () => {
    const store = ledger();
    const ops = new OperationLedger(store.db);
    const results = await Promise.allSettled([ops.claim({ ...base, id: 'op-a' }), ops.claim({ ...base, id: 'op-b' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.ok(rejected?.reason instanceof ReconciliationRequiredError);
  });
});

describe('ActionApprovals', () => {
  const action = { tool: 'netlify.deploy', connectionId: 'conn-1', projectId: 'p1', destination: 'site-abc', inputs: { dir: 'dist', production: true } };

  it('hashes an action independently of key order', () => {
    assert.equal(hashAction(action), hashAction({ ...action, inputs: { production: true, dir: 'dist' } }));
    assert.notEqual(hashAction(action), hashAction({ ...action, inputs: { ...action.inputs, production: false } }));
    assert.notEqual(hashAction(action), hashAction({ ...action, destination: 'site-xyz' }));
    assert.notEqual(hashAction(action), hashAction({ ...action, projectId: 'p2' }));
    assert.notEqual(hashAction(action), hashAction({ ...action, connectionId: 'conn-2' }));
  });

  it('is consumed exactly once, only by the same user and session for the same action, before expiry', async () => {
    const approvals = new ActionApprovals(ledger().db, 1000);
    const now = new Date('2026-10-31T20:00:00Z');
    const issued = await approvals.issue({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'alice', action, now });
    assert.equal(issued.actionHash, hashAction(action));
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'mallory', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'wrong-user');
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-2', ownerUid: 'alice', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'wrong-session');
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'alice', action: { ...action, destination: 'site-xyz' }, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'mismatch');
    await assert.rejects(approvals.consume({ id: 'missing', sessionId: 'sess-1', ownerUid: 'alice', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'missing');
    await approvals.consume({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'alice', action, now });
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'alice', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'consumed');
    await approvals.issue({ id: 'appr-2', sessionId: 'sess-1', ownerUid: 'alice', action, now });
    await assert.rejects(approvals.consume({ id: 'appr-2', sessionId: 'sess-1', ownerUid: 'alice', action, now: new Date(now.getTime() + 1000) }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'expired');
  });
});

describe('OAuthStateStore', () => {
  const start = { ownerUid: 'alice', connector: 'netlify' as const, redirectUri: 'https://api.example/connections/netlify/callback', projectIds: ['p1'] };

  it('binds state to user, connector and callback, and allows a single completion', async () => {
    const states = new OAuthStateStore(withProjects().db, 1000);
    const now = new Date('2026-10-31T20:00:00Z');
    await assert.rejects(states.begin({ ...start, projectIds: ['p1', 'someone-elses'] }, now), /No accessible project/);
    await assert.rejects(states.begin({ ...start, ownerUid: 'mallory' }, now), /No accessible project/);
    const begun = await states.begin(start, now);
    assert.equal(begun.codeChallenge, pkceChallenge(begun.codeVerifier));
    const reject = async (overrides: Partial<Parameters<OAuthStateStore['complete']>[0]>, reason: OAuthStateError['reason']) =>
      assert.rejects(states.complete({ state: begun.state, ownerUid: 'alice', connector: 'netlify', redirectUri: start.redirectUri, now, ...overrides }),
        (e: unknown) => e instanceof OAuthStateError && e.reason === reason);
    await reject({ state: 'nope' }, 'unknown');
    await reject({ ownerUid: 'mallory' }, 'wrong-user');
    await reject({ connector: 'vercel' }, 'wrong-connector');
    await reject({ redirectUri: 'https://evil.example/cb' }, 'redirect-mismatch');
    await reject({ now: new Date(now.getTime() + 1000) }, 'expired');
    const record = await states.complete({ state: begun.state, ownerUid: 'alice', connector: 'netlify', redirectUri: start.redirectUri, now });
    assert.deepEqual(record.projectIds, ['p1']);
    assert.equal(record.codeVerifier, begun.codeVerifier);
    await reject({}, 'used');
  });
});
