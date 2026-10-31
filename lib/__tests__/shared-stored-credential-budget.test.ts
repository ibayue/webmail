// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStoredCredentialRefused,
  recordStoredCredentialStatus,
  resetStoredCredentialBudgetForTests,
} from '@/lib/stalwart/stored-credential-budget';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from './helpers/shared-store-down';

// Each replica kept its own list of refused stored credentials, so a stale
// password was sent to the mail server once per replica and hour, and the
// global ceiling of 20 refusals became 20 per replica (#1066).

const basic = (user: string) => `Basic ${Buffer.from(`${user}:secret`).toString('base64')}`;
const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
let store: ReturnType<typeof switchableSharedStore>;

/** Another replica: this process forgets everything it kept itself. */
const otherReplica = () => resetStoredCredentialBudgetForTests();

beforeEach(() => {
  resetLocalStoreForTests();
  resetStoredCredentialBudgetForTests();
  store = switchableSharedStore();
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetStoredCredentialBudgetForTests();
});

describe('stored credential budget with a shared store', () => {
  it('refuses on every replica a credential one replica saw refused', async () => {
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    otherReplica();
    expect(await isStoredCredentialRefused(basic('stale'), T0 + 59 * MIN)).toBe(true);
    expect(await isStoredCredentialRefused(basic('other'), T0 + 59 * MIN)).toBe(false);
    expect(await isStoredCredentialRefused(basic('stale'), T0 + 61 * MIN)).toBe(false);
  });

  it('counts the 20 refusals of the window across replicas', async () => {
    await recordStoredCredentialStatus(basic('active'), 200, T0);
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 0) otherReplica();
      await recordStoredCredentialStatus(basic(`stale-${i}`), 401, T0 + i);
    }
    otherReplica();
    expect(await isStoredCredentialRefused(basic('fresh'), T0 + MIN)).toBe(true);
    // Worked within the window on another replica: still goes upstream.
    expect(await isStoredCredentialRefused(basic('active'), T0 + MIN)).toBe(false);
    expect(await isStoredCredentialRefused(basic('fresh'), T0 + 16 * MIN)).toBe(false);
  });

  it('lifts a refusal everywhere when the credential signs in again', async () => {
    await recordStoredCredentialStatus(basic('a'), 401, T0);
    otherReplica();
    await recordStoredCredentialStatus(basic('a'), 200, T0 + MIN);
    otherReplica();
    expect(await isStoredCredentialRefused(basic('a'), T0 + 2 * MIN)).toBe(false);
  });

  it('writes a working credential to the store at most once a minute', async () => {
    const set = vi.spyOn(store.kv, 'set');
    for (let i = 0; i < 5; i++) await recordStoredCredentialStatus(basic('busy'), 200, T0 + i * 1000);
    expect(set).toHaveBeenCalledTimes(1);
    await recordStoredCredentialStatus(basic('busy'), 200, T0 + MIN);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('falls back to what this replica knows when the store is down', async () => {
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    store.down = true;
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(true);
    expect(await isStoredCredentialRefused(basic('good'), T0 + MIN)).toBe(false);
    // Recorded here even though the store can't take it.
    await recordStoredCredentialStatus(basic('later'), 401, T0 + MIN);
    expect(await isStoredCredentialRefused(basic('later'), T0 + 2 * MIN)).toBe(true);
  });
});
