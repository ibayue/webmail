/**
 * The device policies (policy.json `organisation.devices`) as the server
 * applies them itself, where it can: the push notification text
 * (app/api/push/preview) and the office editor (app/api/wopi). The browser
 * talks to the mail server directly for everything else, so those gates
 * are browser-only (lib/device-policy.ts).
 *
 * Who the caller is comes from their own JMAP session, never from the
 * browser. For these gates every non-personal account in the session
 * counts as a group (a mailbox another person shared counts too): more
 * scopes matched means more held back, the safe direction. A session that
 * can't be read counts the login address alone.
 */

import { createHash } from 'node:crypto';
import { configManager } from './config-manager';
import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from './organisation-policy';
import { resolvePolicy, type PolicySubject } from './policy-scopes';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';

export type ServerDevicePolicy = OrganisationPolicy['devices'];

export interface DeviceCreds {
  serverUrl: string;
  authHeader: string;
  username: string;
  accountName?: string;
  trusted: boolean;
}

const TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = Symbol.for('bulwark.serverDeviceSubjects');

// One cache per process, not per bundle copy.
function cache(): Map<string, { at: number; subject: Promise<PolicySubject> }> {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, { at: number; subject: Promise<PolicySubject> }> };
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY];
}

async function readSubject(creds: DeviceCreds): Promise<PolicySubject> {
  const email = (creds.accountName || creds.username || '').trim().toLowerCase();
  const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, { trusted: creds.trusted }).catch(() => null);
  const accounts = (session?.accounts ?? {}) as Record<string, { name?: string; isPersonal?: boolean }>;
  const groups = Object.values(accounts)
    .filter((account) => account?.isPersonal === false && typeof account.name === 'string' && account.name.includes('@'))
    .map((account) => account.name!.trim().toLowerCase())
    .filter((name) => name !== email)
    .sort();
  return { email, groups };
}

/** The caller as the device gates see them, kept for a few minutes per credential. Never rejects. */
export function strictDeviceSubject(creds: DeviceCreds): Promise<PolicySubject> {
  const key = createHash('sha256').update(`${creds.serverUrl}\n${creds.authHeader}`).digest('hex');
  const entries = cache();
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;
  const subject = readSubject(creds);
  entries.set(key, { at: now, subject });
  if (entries.size > 1000) {
    for (const [k, v] of entries) if (now - v.at >= TTL_MS) entries.delete(k);
  }
  return subject;
}

/** The device policy that applies to this login. */
export async function serverDevicePolicy(creds: DeviceCreds): Promise<ServerDevicePolicy> {
  await configManager.ensureLoaded();
  const subject = await strictDeviceSubject(creds);
  const devices = resolvePolicy(configManager.getPolicy(), subject).policy.organisation?.devices;
  return { ...DEFAULT_ORGANISATION_POLICY.devices, ...(devices ?? {}) };
}

/**
 * The WOPI CheckFileInfo switches for the office editor (Collabora and
 * ONLYOFFICE read these): no printing, no export or "save a copy" when
 * downloads or export are off, and the watermark.
 */
export function wopiDeviceInfo(devices: ServerDevicePolicy, username: string, now: Date = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (devices.noPrint) {
    out.DisablePrint = true;
    out.HidePrintOption = true;
  }
  if (devices.noDownloads || devices.noExport) {
    out.DisableExport = true;
    out.HideExportOption = true;
    out.HideSaveOption = true;
    out.DisableCopy = true;
  }
  if (devices.watermark) out.WatermarkText = `${username} · ${now.toISOString().slice(0, 10)}`;
  return out;
}

/** For tests. */
export function clearServerDeviceSubjects(): void {
  cache().clear();
}
