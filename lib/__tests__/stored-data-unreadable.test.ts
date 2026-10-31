// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A settings file or plugin vault that exists but doesn't decrypt (written
// with another session secret, or cut short) used to read as "nothing
// stored". The next save then merged into nothing and overwrote the user's
// real data. Now the read throws, and the routes answer 503 and write nothing.

let secret = 'a'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => secret,
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'settingsSyncEnabled' ? true : fallback),
    getPolicy: () => ({ restrictions: {}, features: { pluginsEnabled: true } }),
  },
}));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false, thirdPartyRefusal: () => null }));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SERVER = 'https://mail.example.org';
const USER = 'alice@example.org';
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({ username: USER, accountName: USER, serverUrl: SERVER, authHeader: 'x' }),
}));
vi.mock('@/lib/plugin-secrets/known-plugins', () => ({
  declaredUserCredential: async () => ({ scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } }),
}));

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bw-unreadable-'));
  vi.stubEnv('SETTINGS_DATA_DIR', path.join(dataDir, 'settings'));
  vi.stubEnv('PLUGIN_SECRETS_DIR', path.join(dataDir, 'plugin-secrets'));
  vi.stubEnv('SETTINGS_SYNC_ENABLED', 'true');
  secret = 'a'.repeat(64);
  jar.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Sign in after the secret change: the context cookie is sealed with the current secret. */
async function signIn() {
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  setStalwartAuthContextInStore({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  } as never, 0, { serverUrl: SERVER, authHeader: 'Bearer t', username: USER });
}

function onlyFile(dir: string): string {
  const [file] = readdirSync(dir).filter((name) => name.endsWith('.enc'));
  return path.join(dir, file);
}

describe('settings that do not decrypt', () => {
  it('reads a missing file as nothing stored and one written with another secret as an error', async () => {
    const { loadUserSettings, saveUserSettings } = await import('@/lib/settings-sync');
    const { StoredDataUnreadableError } = await import('@/lib/stored-data-errors');
    expect(await loadUserSettings(USER, SERVER)).toBeNull();

    await saveUserSettings(USER, SERVER, { theme: 'dark' });
    secret = 'b'.repeat(64);
    await expect(loadUserSettings(USER, SERVER)).rejects.toBeInstanceOf(StoredDataUnreadableError);

    writeFileSync(onlyFile(path.join(dataDir, 'settings')), Buffer.alloc(10));
    await expect(loadUserSettings(USER, SERVER)).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });

  it('answers 503 to GET and POST and leaves the stored file as it was', async () => {
    const { saveUserSettings } = await import('@/lib/settings-sync');
    await saveUserSettings(USER, SERVER, { theme: 'dark', templates: [{ id: 'a' }] });
    const file = onlyFile(path.join(dataDir, 'settings'));
    const before = readFileSync(file);
    secret = 'b'.repeat(64);
    await signIn();

    const { GET, POST } = await import('@/app/api/settings/route');
    const got = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': USER, 'x-settings-server': SERVER },
    }));
    expect(got.status).toBe(503);

    const saved = await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, serverUrl: SERVER, settings: { theme: 'light' } }),
    }));
    expect(saved.status).toBe(503);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe('a plugin vault that does not decrypt', () => {
  const user = { username: USER, serverUrl: SERVER };
  const input = { origin: 'https://cloud.example.org', inject: { type: 'basic' } as const, label: 'Nextcloud', secret: 'pw' };

  it('reads a missing vault as empty and one written with another secret as an error', async () => {
    const { listUserCredentials, putUserCredential } = await import('@/lib/plugin-secrets/vault');
    const { StoredDataUnreadableError } = await import('@/lib/stored-data-errors');
    expect(await listUserCredentials(user)).toEqual([]);

    await putUserCredential(user, 'nextcloud', 'cloud', input);
    secret = 'b'.repeat(64);
    await expect(listUserCredentials(user)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    // A write merges into what is stored, so it must not land either.
    await expect(putUserCredential(user, 'other', 'x', input)).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });

  it('answers 503 on the credential routes and the proxy and leaves the vault as it was', async () => {
    const { putUserCredential } = await import('@/lib/plugin-secrets/vault');
    await putUserCredential(user, 'nextcloud', 'cloud', input);
    const file = onlyFile(path.join(dataDir, 'plugin-secrets'));
    const before = readFileSync(file);
    secret = 'b'.repeat(64);

    const { GET, POST, DELETE } = await import('@/app/api/plugin-secrets/route');
    const { POST: proxy } = await import('@/app/api/plugin-proxy/route');
    const same = { 'sec-fetch-site': 'same-origin' };

    expect((await GET(new NextRequest('http://localhost/api/plugin-secrets'))).status).toBe(503);
    const post = await POST(new NextRequest('http://localhost/api/plugin-secrets', {
      method: 'POST',
      headers: same,
      body: JSON.stringify({ pluginId: 'nextcloud', credentialId: 'other', label: 'x', origin: 'https://cloud.example.org', inject: { type: 'basic' }, secret: 's' }),
    }));
    expect(post.status).toBe(503);
    const del = await DELETE(new NextRequest('http://localhost/api/plugin-secrets?plugin=nextcloud', { method: 'DELETE', headers: same }));
    expect(del.status).toBe(503);
    const proxied = await proxy(new NextRequest(
      'http://localhost/api/plugin-proxy?plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fcloud.example.org%2F',
      { method: 'POST', headers: same },
    ));
    expect(proxied.status).toBe(503);

    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
