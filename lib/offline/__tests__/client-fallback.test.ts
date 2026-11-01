import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { startOfflineMode, wipeEverything } from '../offline-mode';
import { forgetIndexes, putEmails, putMisc, emailIndex } from '../cache';
import { forgetDeviceKey } from '../crypto';
import { deleteOfflineDb } from '../db';
import { useOfflineStore, writeEnabled } from '../state';
import { syncAccount } from '../sync';

const SERVER = 'https://mail.example.org';
const SESSION = {
  apiUrl: `${SERVER}/jmap/`,
  downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
  accounts: { j1: { name: 'alice', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'j1' },
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  username: 'alice@example.org',
};

let probeOk = true;
let apiFails = false;

beforeEach(async () => {
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  localStorage.clear();
  probeOk = true;
  apiFails = false;
  useOfflineStore.setState({ networkDown: false, browserOffline: false });
  usePolicyStore.setState({ loaded: true, subject: null, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', serverUrl: SERVER, username: 'alice@example.org' } as never] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.mode === 'no-cors') {
      if (!probeOk) throw new TypeError('Failed to fetch');
      return new Response(null, { status: 200 });
    }
    if (String(url).endsWith('/.well-known/jmap')) return new Response(JSON.stringify(SESSION), { status: 200 });
    if (apiFails) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ methodResponses: [['Email/get', { accountId: 'j1', list: [], notFound: ['m1'] }, '0']] }), { status: 200 });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await wipeEverything();
});

async function connectedClient(): Promise<JMAPClient> {
  const client = new JMAPClient(SERVER, 'alice@example.org', 'pw');
  await client.connect();
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
  return client;
}

describe('falling back to the device', () => {
  it('answers from the device when the server is gone', async () => {
    const client = await connectedClient();
    writeEnabled(['acc']);
    const stop = startOfflineMode();
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString(), subject: 'Kept', bodyValues: { 1: { value: 'x' } } }]);
    apiFails = true;
    probeOk = false;
    const email = await client.getEmail('m1');
    expect(email?.subject).toBe('Kept');
    expect(useOfflineStore.getState().networkDown).toBe(true);
    stop();
  });

  it('keeps a refused request an error while the server answers', async () => {
    const client = await connectedClient();
    writeEnabled(['acc']);
    const stop = startOfflineMode();
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString(), subject: 'Kept', bodyValues: { 1: { value: 'x' } } }]);
    apiFails = true;
    probeOk = true;
    // getEmail swallows errors into null: the device's copy isn't passed off as the server's answer.
    expect(await client.getEmail('m1')).toBeNull();
    expect(useOfflineStore.getState().networkDown).toBe(false);
    stop();
  });
});

describe('the sync', () => {
  function fakeClient(opts: { failQuery?: boolean }) {
    return {
      getSessionSnapshot: () => SESSION,
      getAccountId: () => 'j1',
      getAllMailboxes: vi.fn(async () => { await putMisc('acc', 'mailboxes', { j1: [{ id: 'inbox', role: 'inbox' }] }); return []; }),
      getMailboxes: vi.fn(async () => []),
      getIdentities: vi.fn(async () => []),
      getRecentEmailIds: vi.fn(async (mailboxId: string) => { if (opts.failQuery && mailboxId === 'archive') throw new Error('refused'); return mailboxId === 'inbox' ? ['new'] : []; }),
      getSomeEmails: vi.fn(async () => []),
      getFullEmails: vi.fn(async (ids: string[]) => {
        await putEmails('acc', 'j1', ids.map((id) => ({ id, mailboxIds: { inbox: true }, receivedAt: new Date().toISOString(), bodyValues: {} })));
        return [];
      }),
      fetchBlob: vi.fn(),
    };
  }
  const deps = { stillActive: () => true, recorded: async () => {}, scopeMailboxes: async () => [{ jmap: 'j1', mailboxId: 'inbox', isInbox: true }] };

  it('fetches what is missing and drops what left the Inbox', async () => {
    await putEmails('acc', 'j1', [{ id: 'gone', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString() }]);
    const client = fakeClient({});
    await syncAccount('acc', client as never, deps);
    expect(client.getFullEmails).toHaveBeenCalledWith(['new'], 'j1');
    const index = await emailIndex('acc');
    expect([...index.values()].map((e) => e.id)).toEqual(['new']);
  });

  it('keeps everything when a folder couldn\'t be asked', async () => {
    await putEmails('acc', 'j1', [{ id: 'kept', mailboxIds: { archive: true }, receivedAt: new Date().toISOString() }]);
    const both = { ...deps, scopeMailboxes: async () => [{ jmap: 'j1', mailboxId: 'inbox', isInbox: true }, { jmap: 'j1', mailboxId: 'archive', isInbox: false }] };
    await syncAccount('acc', fakeClient({ failQuery: true }) as never, both);
    expect([...(await emailIndex('acc')).values()].map((e) => e.id).sort()).toEqual(['kept', 'new']);
  });
});
