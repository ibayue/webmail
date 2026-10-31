/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Moving a single-instance install to a shared store (#1066): the admin
// config, password, state and audit log come along, a second run changes
// nothing, and the local files stay as they were.

import { steps } from '../import/admin';
import { importLocalData } from '../import';
import { getStore, setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';
import { adminConfigDocs, adminStateDocs } from '@/lib/admin/admin-store';
import { AUDIT_LOG_OPTIONS } from '@/lib/admin/audit';

let dir: string;
const config = (file: string) => path.join(dir, 'config', file);
const state = (file: string) => path.join(dir, 'state', file);
const LOCAL: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-import-admin-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  mkdirSync(path.join(dir, 'config'));
  mkdirSync(path.join(dir, 'state'));
  const files = {
    [config('config.json')]: JSON.stringify({ appName: 'Imported', setupComplete: true }, null, 2),
    [config('policy.json')]: JSON.stringify({ features: { calendarEnabled: false } }, null, 2),
    [config('admin.json')]: JSON.stringify({ passwordHash: '$scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==' }, null, 2),
    [config('.config-locked')]: '2026-10-31T12:00:00.000Z',
    [state('admin-state.json')]: JSON.stringify({ createdAt: 'x', lastLogin: null, passwordChangedAt: 'x', sessionGeneration: 3 }, null, 2),
    [state('audit.log')]: '{"ts":"1","action":"admin.login","detail":{},"ip":"1"}\n{"ts":"2","action":"admin.logout","detail":{},"ip":"1"}\n',
  };
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(file, content);
    LOCAL[file] = content;
  }
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(dir, 'store')));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin import', () => {
  it('copies the admin files once and leaves them on disk', async () => {
    const mtimes = Object.keys(LOCAL).map((file) => statSync(file).mtimeMs);

    expect((await importLocalData(steps)).imported).toEqual({ 'admin-config': 4, 'admin-state': 1, audit: 2 });
    for (const id of ['config.json', 'policy.json', 'admin.json', '.config-locked']) {
      expect((await adminConfigDocs().get(id))!.data.toString('utf-8')).toBe(LOCAL[config(id)]);
    }
    expect((await adminStateDocs().get('admin-state.json'))!.data.toString('utf-8')).toBe(LOCAL[state('admin-state.json')]);
    const log = await getStore().log('audit', AUDIT_LOG_OPTIONS).readAll();
    expect(log.map((line) => JSON.parse(line).action)).toEqual(['admin.login', 'admin.logout']);

    expect((await importLocalData(steps)).imported).toEqual({ 'admin-config': 0, 'admin-state': 0, audit: 0 });
    expect(await getStore().log('audit', AUDIT_LOG_OPTIONS).length()).toBe(2);

    Object.keys(LOCAL).forEach((file, i) => {
      expect(readFileSync(file, 'utf-8')).toBe(LOCAL[file]);
      expect(statSync(file).mtimeMs).toBe(mtimes[i]);
    });
  });

  it('keeps what the store already holds', async () => {
    await adminConfigDocs().put('config.json', '{"appName":"Already shared"}');
    expect((await importLocalData(steps)).imported['admin-config']).toBe(3);
    expect((await adminConfigDocs().get('config.json'))!.data.toString('utf-8')).toBe('{"appName":"Already shared"}');
  });
});
