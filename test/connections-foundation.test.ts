import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActionApprovals, ApprovalRejectedError, hashAction } from '../src/connections/approvals.ts';
import { OAuthStateError, OAuthStateStore, pkceChallenge } from '../src/connections/oauth.ts';
import { OperationAlreadyClaimedError, OperationLedger, ReconciliationRequiredError } from '../src/connections/operations.ts';
import { ledger } from './support/ledger.ts';

const base = { connectionId: 'conn-1', action: 'deploy', sessionId: 'sess-1', ownerUid: 'alice' };

describe('OperationLedger', () => {
  it('claims an operation once and refuses a second claim of the same id', async () => {
    const ops = new OperationLedger(ledger().db);
    const claimed = await ops.claim({ ...base, id: 'op-1' });
    assert.equal(claimed.status, 'claimed');
    await assert.rejects(ops.claim({ ...base, id: 'op-1' }), OperationAlreadyClaimedError);
  });

  it('blocks the same action while an earlier operation is claimed or uncertain, until reconciled', async () => {
    const ops = new OperationLedger(ledger().db);
    await ops.claim({ ...base, id: 'op-1' });
    await assert.rejects(ops.claim({ ...base, id: 'op-2' }), ReconciliationRequiredError);
    await ops.recordProviderRef('op-1', 'dpl_123');
    await ops.settle('op-1', 'uncertain', 'response lost');
    await assert.rejects(ops.claim({ ...base, id: 'op-2' }), (error: unknown) =>
      error instanceof ReconciliationRequiredError && error.operationId === 'op-1');
    const [pending] = await ops.uncertain('conn-1');
    assert.equal(pending?.providerRef, 'dpl_123');
    await ops.settle('op-1', 'succeeded', 'found deployment dpl_123 READY');
    await assert.rejects(ops.settle('op-1', 'failed'), /already succeeded/);
    const next = await ops.claim({ ...base, id: 'op-2' });
    assert.equal(next.id, 'op-2');
    const other = await ops.claim({ ...base, action: 'sites.read', id: 'op-3' });
    assert.equal(other.action, 'sites.read');
  });
});

describe('ActionApprovals', () => {
  const action = { tool: 'netlify.deploy', connectionId: 'conn-1', destination: 'site-abc', inputs: { dir: 'dist', production: true } };

  it('hashes an action independently of key order', () => {
    assert.equal(hashAction(action), hashAction({ ...action, inputs: { production: true, dir: 'dist' } }));
    assert.notEqual(hashAction(action), hashAction({ ...action, inputs: { ...action.inputs, production: false } }));
    assert.notEqual(hashAction(action), hashAction({ ...action, destination: 'site-xyz' }));
  });

  it('is consumed exactly once, only by the same session and the same action, before expiry', async () => {
    const approvals = new ActionApprovals(ledger().db, 1000);
    const now = new Date('2026-10-31T20:00:00Z');
    const issued = await approvals.issue({ id: 'appr-1', sessionId: 'sess-1', ownerUid: 'alice', action, now });
    assert.equal(issued.actionHash, hashAction(action));
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-2', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'wrong-session');
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-1', action: { ...action, destination: 'site-xyz' }, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'mismatch');
    await assert.rejects(approvals.consume({ id: 'missing', sessionId: 'sess-1', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'missing');
    await approvals.consume({ id: 'appr-1', sessionId: 'sess-1', action, now });
    await assert.rejects(approvals.consume({ id: 'appr-1', sessionId: 'sess-1', action, now }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'consumed');
    await approvals.issue({ id: 'appr-2', sessionId: 'sess-1', ownerUid: 'alice', action, now });
    await assert.rejects(approvals.consume({ id: 'appr-2', sessionId: 'sess-1', action, now: new Date(now.getTime() + 1000) }),
      (e: unknown) => e instanceof ApprovalRejectedError && e.reason === 'expired');
  });
});

describe('OAuthStateStore', () => {
  const start = { ownerUid: 'alice', connector: 'netlify' as const, redirectUri: 'https://api.example/connections/netlify/callback', projectIds: ['p1'] };

  it('binds state to user, connector and callback, and allows a single completion', async () => {
    const states = new OAuthStateStore(ledger().db, 1000);
    const now = new Date('2026-10-31T20:00:00Z');
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
