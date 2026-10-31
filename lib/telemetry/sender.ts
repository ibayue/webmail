import { logger } from '@/lib/logger';
import { effectiveConsent, endpointEnabled, loadState, updateState } from './state';
import { buildPayload } from './payload';
import { fetchTelemetryTarget, resolveEndpointAllowed } from './endpoint-guard';
import { DEFAULT_ENDPOINT } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const JITTER_MS = 2 * 60 * 60 * 1000; // ± 2 hours
const FIRST_DELAY_MS = 60 * 60 * 1000;  // 1 hour after consent

// On globalThis: Next loads this module once per bundle (instrumentation,
// each route), and a reschedule from a route must clear the timer the
// instrumentation copy started, not a copy of its own.
const TIMER_KEY = Symbol.for('bulwark.telemetry.timer');
function timer(): { current: NodeJS.Timeout | null } {
  const g = globalThis as typeof globalThis & { [TIMER_KEY]?: { current: NodeJS.Timeout | null } };
  return (g[TIMER_KEY] ??= { current: null });
}

function jitteredDelay(base: number): number {
  const j = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(60_000, base + j);
}

export async function sendOnce(opts?: { reason?: string }): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  // effectiveConsent() is off in the no-third-party mode, so this also stops
  // a manual "send now" before any request (#903).
  const { consent, source, state } = await effectiveConsent();
  if (consent !== 'on') return { ok: false, error: `consent ${consent} (source ${source})` };
  // A cleared collector URL is stored as '' and switches sending off; only a
  // state file without the field at all gets the project's collector.
  const endpoint = state.endpoint ?? DEFAULT_ENDPOINT;
  if (!endpointEnabled(endpoint)) return { ok: false, error: 'endpoint blank' };

  // Re-check at fetch time: defeats DNS rebinding, and catches the case
  // where state.json was edited out-of-band to bypass the admin API.
  const guard = await resolveEndpointAllowed(endpoint);
  if (!guard.ok) {
    logger.warn('telemetry: endpoint blocked', { reason: guard.reason });
    return { ok: false, error: `endpoint blocked: ${guard.reason}` };
  }

  const payload = await buildPayload();
  try {
    // Never follows redirects: the endpoint guard only vetted the URL we
    // were given, so a 3xx to an internal host would bypass it.
    const res = await fetchTelemetryTarget(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.ok;
    if (ok) {
      const at = new Date().toISOString();
      await updateState((next) => { next.lastSentAt = at; });
    }
    logger.info('telemetry: heartbeat', {
      ok, status: res.status, reason: opts?.reason ?? 'scheduled',
    });
    return { ok, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('telemetry: heartbeat failed', { error: msg });
    return { ok: false, error: msg };
  }
}

async function scheduleNext(delayMs: number): Promise<void> {
  const t = timer();
  if (t.current) clearTimeout(t.current);
  const at = new Date(Date.now() + delayMs).toISOString();
  await updateState((state) => { state.nextScheduledAt = at; });
  if (t.current) clearTimeout(t.current);
  t.current = setTimeout(() => { void tick(); }, delayMs);
  // Don't keep the process alive just for this.
  t.current.unref?.();
}

async function tick(): Promise<void> {
  await sendOnce({ reason: 'scheduled' });
  await scheduleNext(jitteredDelay(DAY_MS));
}

// Called from instrumentation. Idempotent.
export async function startScheduler(): Promise<void> {
  const { consent } = await effectiveConsent();
  if (consent !== 'on') {
    logger.info('telemetry: scheduler not started', { consent });
    return;
  }
  const state = await loadState();
  if (!endpointEnabled(state.endpoint ?? DEFAULT_ENDPOINT)) {
    logger.info('telemetry: scheduler not started', { consent, endpoint: 'blank' });
    return;
  }
  // If we have a next-scheduled time in the future use it; otherwise schedule
  // FIRST_DELAY_MS out. This means after a restart we don't fire immediately.
  let delay = FIRST_DELAY_MS;
  if (state.nextScheduledAt) {
    const remaining = new Date(state.nextScheduledAt).getTime() - Date.now();
    if (remaining > 0) delay = Math.min(remaining, DAY_MS + JITTER_MS);
  }
  await scheduleNext(delay);
  logger.info('telemetry: scheduler started', {
    nextInMs: delay,
    endpoint: state.endpoint,
  });
}

export async function stopScheduler(): Promise<void> {
  const t = timer();
  if (t.current) clearTimeout(t.current);
  t.current = null;
}

// Called when consent flips on/off or the collector URL changes via the UI.
export async function reschedule(): Promise<void> {
  await stopScheduler();
  await startScheduler();
}
