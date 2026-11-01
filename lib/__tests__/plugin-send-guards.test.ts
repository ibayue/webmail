import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSendGuards,
  downSendGuards,
  guardsSending,
  rememberDeclaredHooks,
  setSendGuardSource,
} from '@/lib/plugin-send-guards';
import { runPluginSendCheck } from '@/lib/outgoing/plugin-send-check';
import { emailHooks } from '@/lib/plugin-hooks';
import type { InstalledPlugin, OutgoingEmail } from '@/lib/plugin-types';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

// A send check the admin force-enabled that is starting, failed to start or
// was turned off after errors used to let every message through.

const guard = (patch: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'send-checks', name: 'Send checks', version: '1.0.0', author: '', description: '', type: 'hook',
  permissions: ['email:send', 'email:read'], entrypoint: 'index.js', enabled: true, status: 'running',
  settings: {}, managed: true, forceEnabled: true, bundleHash: 'abc', ...patch,
});

const email: OutgoingEmail = { to: ['x@example.org'], cc: [], bcc: [], subject: 's', htmlBody: '', textBody: 't', identityId: 'i', attachments: [] };

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  usePluginStore.setState({ plugins: [] });
  emailHooks.onBeforeEmailSend.clear();
  vi.useRealTimers();
});

describe('downSendGuards', () => {
  it('counts a required guard that is starting, failed to start or was turned off after errors', () => {
    usePluginStore.setState({
      plugins: [
        guard({ id: 'a', status: 'enabled' }),
        guard({ id: 'b', status: 'error', error: 'Bundle integrity mismatch: expected x, got y' }),
        guard({ id: 'c', status: 'error', error: 'auto-disabled', enabled: false }),
        guard({ id: 'd', status: 'running' }),
      ],
    });
    expect(downSendGuards().map((g) => [g.id, g.state])).toEqual([['a', 'loading'], ['b', 'failed'], ['c', 'failed']]);
  });

  it("doesn't count a plugin Bulwark refused on purpose, nor one the user turned on", () => {
    usePluginStore.setState({
      plugins: [
        guard({ id: 'a', status: 'error', error: 'third-party-off' }),
        guard({ id: 'b', status: 'error', error: 'approval-denied' }),
        guard({ id: 'c', status: 'error', error: 'Privileged tier requires the "crypto:full" permission' }),
        guard({ id: 'd', status: 'enabled', forceEnabled: false, managed: false }),
      ],
    });
    expect(downSendGuards()).toEqual([]);
  });

  it('counts a plugin the policy forces on', () => {
    const spy = vi.spyOn(usePolicyStore.getState(), 'isPluginForceEnabled').mockImplementation((id: string) => id === 'p');
    usePluginStore.setState({ plugins: [guard({ id: 'p', forceEnabled: false, status: 'enabled' })] });
    expect(downSendGuards().map((g) => g.id)).toEqual(['p']);
    spy.mockRestore();
  });

  it('knows a guard by the hooks of its last start, else by the email:send permission', () => {
    expect(guardsSending(guard())).toBe(true);
    expect(guardsSending(guard({ permissions: ['email:read'] }))).toBe(false);
    rememberDeclaredHooks(guard(), 'abc', ['onComposeSend']);
    expect(guardsSending(guard())).toBe(false);
    // Another bundle: what the old one did no longer says anything.
    expect(guardsSending(guard({ bundleHash: '"DEF"' }))).toBe(true);
    rememberDeclaredHooks(guard({ bundleHash: 'def' }), 'def', ['onBeforeEmailSend']);
    expect(guardsSending(guard({ bundleHash: '"DEF"' }))).toBe(true);
  });
});

describe('awaitSendGuards', () => {
  it('waits for a guard that is starting and goes on once it runs', async () => {
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const waiting = awaitSendGuards(5000);
    usePluginStore.setState({ plugins: [guard({ status: 'running' })] });
    expect(await waiting).toEqual([]);
  });

  it('gives up after the wait and reports it down', async () => {
    vi.useFakeTimers();
    usePluginStore.setState({ plugins: [guard({ status: 'enabled' })] });
    const waiting = awaitSendGuards(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toEqual([{ id: 'send-checks', name: 'Send checks', state: 'loading' }]);
  });

  it('sees nothing without a source (no plugin store, as in Lite)', async () => {
    setSendGuardSource(null);
    try {
      usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'auto-disabled' })] });
      expect(await awaitSendGuards(10)).toEqual([]);
    } finally {
      setSendGuardSource({
        snapshot: () => ({ plugins: usePluginStore.getState().plugins, forced: (p) => !!p.forceEnabled }),
        subscribe: (l) => usePluginStore.subscribe(l),
      });
    }
  });
});

describe('runPluginSendCheck', () => {
  it('holds the send while a required guard is down, without asking the others', async () => {
    const handler = vi.fn(() => undefined);
    emailHooks.onBeforeEmailSend.register('other', handler);
    usePluginStore.setState({ plugins: [guard({ status: 'error', error: 'auto-disabled', enabled: false })] });
    expect(await runPluginSendCheck(email)).toBe('guard-down');
    expect(handler).not.toHaveBeenCalled();
    usePluginStore.setState({ plugins: [guard()] });
    expect(await runPluginSendCheck(email)).toBe('allowed');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
