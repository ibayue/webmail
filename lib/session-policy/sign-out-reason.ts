/**
 * Why Bulwark signed the user out on its own, for the login page to say.
 * Kept in sessionStorage: the tab that signed out shows it once.
 */

export type SessionEndReason =
  | { kind: 'idle'; minutes: number; draftsUnsaved?: boolean; outboxLost?: string[] }
  | { kind: 'max'; hours: number; draftsUnsaved?: boolean; outboxLost?: string[] };

const KEY = 'session_end_reason';

export function rememberSessionEnd(reason: SessionEndReason): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(reason));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Messages written offline that the automatic sign-out deleted unsent
 * (offline mode, #523): their subjects, for the login page to name. Added
 * to the reason the session timer left; a sign-out by the user (who was
 * asked first) leaves none.
 */
export function noteOutboxLost(subjects: string[]): void {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw || subjects.length === 0) return;
    const reason = JSON.parse(raw) as Record<string, unknown>;
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...reason, outboxLost: subjects.slice(0, 20) }));
  } catch {
    /* storage unavailable */
  }
}

/** Takes a reason back: an account is signed in after all. */
export function clearSessionEnd(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The reason, once; null when the user wasn't signed out by a session limit. */
export function consumeSessionEnd(): SessionEndReason | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lost = Array.isArray(parsed.outboxLost) ? parsed.outboxLost.filter((s): s is string => typeof s === 'string') : [];
    const drafts = {
      ...(parsed.draftsUnsaved === true ? { draftsUnsaved: true } : {}),
      ...(lost.length ? { outboxLost: lost } : {}),
    };
    if (parsed.kind === 'idle' && typeof parsed.minutes === 'number') return { kind: 'idle', minutes: parsed.minutes, ...drafts };
    if (parsed.kind === 'max' && typeof parsed.hours === 'number') return { kind: 'max', hours: parsed.hours, ...drafts };
    return null;
  } catch {
    return null;
  }
}
