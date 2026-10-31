import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import { isStoreUnavailable, StoredDataUnreadableError } from '@/lib/stored-data-errors';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

type Settings = Record<string, unknown>;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createHash('sha256').update(secret).digest();
}

export function getSettingsDir(): string {
  return process.env.SETTINGS_DATA_DIR || path.join(process.cwd(), 'data', 'settings');
}

/** The document id of an account's settings: sha256 of `user:server`, hex. */
export function settingsId(username: string, serverUrl: string): string {
  return createHash('sha256').update(`${username}:${serverUrl}`).digest('hex');
}

const SETTINGS_FILE = /^[0-9a-f]{64}\.enc$/;

/**
 * One encrypted document per account (#1066). Local mode: today's
 * `<settings dir>/<id>.enc`, `iv‖tag‖ciphertext`. The account archives live
 * in a subfolder of the same dir and are not part of this collection.
 */
export const SETTINGS_COLLECTION: CollectionOptions = {
  local: {
    dir: () => getSettingsDir(),
    file: (id) => `${id}.enc`,
    idOf: (relative) => (SETTINGS_FILE.test(relative) ? relative.slice(0, -'.enc'.length) : null),
  },
};

function collection() {
  return getStore().collection('settings', SETTINGS_COLLECTION);
}

function encryptSettings(settings: Settings): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptSettings(data: Buffer): Settings {
  if (data.length < IV_LENGTH + TAG_LENGTH) throw new StoredDataUnreadableError('settings');
  const key = getKey();
  try {
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    logger.warn('Failed to decrypt user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw new StoredDataUnreadableError('settings', { cause: error });
  }
}

export async function saveUserSettings(username: string, serverUrl: string, settings: Settings): Promise<void> {
  await collection().put(settingsId(username, serverUrl), encryptSettings(settings));
}

/**
 * The user's stored settings, or null when none are stored. A document that
 * exists but can't be read or decrypted (another session secret, cut short)
 * throws StoredDataUnreadableError: treating it as "nothing stored" would
 * let the next save overwrite the user's real settings. A shared store that
 * can't be reached throws StoreUnavailableError.
 */
export async function loadUserSettings(username: string, serverUrl: string): Promise<Settings | null> {
  let stored;
  try {
    stored = await collection().get(settingsId(username, serverUrl));
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    logger.warn('Failed to read user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw new StoredDataUnreadableError('settings', { cause: error });
  }
  return stored ? decryptSettings(stored.data) : null;
}

/**
 * Read, change and write the user's settings in one step, so a save that
 * lands at the same time (another tab, another replica) isn't lost: `change`
 * gets what is stored now (null for nothing) and returns what to store. It
 * may run more than once. Throws like loadUserSettings, writing nothing.
 */
export async function updateUserSettings(
  username: string,
  serverUrl: string,
  change: (stored: Settings | null) => Settings,
): Promise<void> {
  await collection().update(settingsId(username, serverUrl), (current) =>
    encryptSettings(change(current ? decryptSettings(current) : null)));
}

export async function deleteUserSettings(username: string, serverUrl: string): Promise<void> {
  try {
    await collection().delete(settingsId(username, serverUrl));
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    logger.warn('Failed to delete user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
