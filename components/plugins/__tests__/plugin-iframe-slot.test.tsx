import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';

// PluginIframeSlot spawns one sandbox iframe per (plugin, slot) via
// createSlotInstance and now watches its initPromise: a failed (or hung) boot
// is retried once instead of leaving a silently blank slot. These tests mock
// the bridge/registry/theme layers so we can drive boot outcomes directly.

const h = vi.hoisted(() => {
  return {
    created: [] as Array<{
      initPromise: Promise<{ hooks: string[]; slots: unknown[]; shortcuts: unknown[] }>;
      resolveInit: (v: { hooks: string[]; slots: unknown[]; shortcuts: unknown[] }) => void;
      rejectInit: (e: Error) => void;
      destroy: ReturnType<typeof vi.fn>;
      updateProps: ReturnType<typeof vi.fn>;
      setTheme: ReturnType<typeof vi.fn>;
    }>,
    // Per-spawn boot plan, consumed left to right; the last entry repeats
    // for any further spawns. 'resolve' | 'reject' | 'hang' (never settles).
    boot: { plan: ['resolve'] as Array<'resolve' | 'reject' | 'hang'> },
    activeEntry: null as null | {
      plugin: { id: string };
      code: string;
      tier: string;
      slotOffers: Array<{ name: string; order: number; hasShouldShow: boolean }>;
      background: { evaluateShouldShow: ReturnType<typeof vi.fn> };
    },
  };
});

vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: () => h.activeEntry,
}));

vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: vi.fn(() => {
    let resolveInit!: (v: { hooks: string[]; slots: unknown[]; shortcuts: unknown[] }) => void;
    let rejectInit!: (e: Error) => void;
    const initPromise = new Promise<{ hooks: string[]; slots: unknown[]; shortcuts: unknown[] }>((res, rej) => {
      resolveInit = res;
      rejectInit = rej;
    });
    const inst = {
      initPromise,
      resolveInit,
      rejectInit,
      destroy: vi.fn(),
      updateProps: vi.fn(),
      setTheme: vi.fn(),
    };
    const behavior = h.boot.plan.length > 1 ? h.boot.plan.shift()! : h.boot.plan[0];
    if (behavior === 'reject') rejectInit(new Error('init error'));
    if (behavior === 'resolve') resolveInit({ hooks: [], slots: [], shortcuts: [] });
    // 'hang': never settles — the watchdog must catch it.
    h.created.push(inst);
    return inst;
  }),
}));

vi.mock('@/lib/plugin-sandbox/host-theme', () => ({
  snapshotHostTheme: () => ({}),
}));

vi.mock('@/stores/theme-store', () => ({
  useThemeStore: (sel: (s: { resolvedTheme: string; activeThemeId: string }) => unknown) =>
    sel({ resolvedTheme: 'light', activeThemeId: 'default' }),
}));

// Import after mocks
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';

function mount(pluginId = 'sw', slot = 'sidebar-widget' as const) {
  return render(
    React.createElement(PluginIframeSlot, { pluginId, slot }),
  );
}

beforeEach(() => {
  h.created.length = 0;
  h.boot.plan = ['resolve'];
  h.activeEntry = {
    plugin: { id: 'sw' },
    code: 'bundle-code',
    tier: 'untrusted',
    slotOffers: [{ name: 'sidebar-widget', order: 100, hasShouldShow: false }],
    background: { evaluateShouldShow: vi.fn() },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PluginIframeSlot boot watchdog', () => {
  it('spawns exactly one instance when boot succeeds', async () => {
    mount();
    await act(async () => {});
    expect(h.created).toHaveLength(1);
    expect(h.created[0].destroy).not.toHaveBeenCalled();
  });

  it('retries once when the slot iframe reports init-error, then stops', async () => {
    h.boot.plan = ['reject', 'reject'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    await act(async () => {});
    // First attempt failed -> retried; second failed too -> gave up.
    expect(h.created).toHaveLength(2);
    expect(h.created[0].destroy).toHaveBeenCalled();
    expect(h.created[1].destroy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retrying'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed to boot after 2 attempts'));
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('recovers when the retry succeeds', async () => {
    h.boot.plan = ['reject', 'resolve'];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    await act(async () => {});
    expect(h.created).toHaveLength(2);
    // The retry resolved on its own - no destroy, no give-up error.
    expect(h.created[1].destroy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('tears down a boot that never completes (watchdog timeout) and retries', async () => {
    vi.useFakeTimers();
    h.boot.plan = ['hang', 'hang'];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    // Flush the spawn + microtasks without advancing the wall clock.
    await act(async () => {});
    expect(h.created).toHaveLength(1);
    // First instance hangs; 30s watchdog fires and respawns.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(h.created).toHaveLength(2);
    expect(h.created[0].destroy).toHaveBeenCalled();
    // Second instance also hangs; second watchdog fires, no more retries.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(h.created).toHaveLength(2);
    expect(h.created[1].destroy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('destroys the live instance on unmount', async () => {
    const { unmount } = mount();
    await act(async () => {});
    expect(h.created).toHaveLength(1);
    unmount();
    expect(h.created[0].destroy).toHaveBeenCalled();
  });
});
