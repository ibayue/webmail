import { createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getStatePath } from '@/lib/admin/paths';
import { logger } from '@/lib/logger';
import { getStore, isSharedMode } from '@/lib/shared-store';
import { IMPERSONATION_REPLAY_WINDOW_SEC, impersonationReplayCache } from './jwt';

const STORE_DIR = 'impersonation-jti';

function markerName(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}

/**
 * The used jtis in the shared store (#1066): one empty document each, gone
 * once its token can no longer verify. Its local layout is today's marker
 * directory, though local mode keeps writing the markers itself (with
 * O_EXCL, which a shared state volume honours).
 */
export function impersonationJtiCollection() {
  return getStore().collection(STORE_DIR, {
    local: { dir: () => getStatePath(STORE_DIR) },
    ttlMs: IMPERSONATION_REPLAY_WINDOW_SEC * 1000,
  });
}

async function pruneExpired(dir: string, nowMs: number): Promise<void> {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    try {
      const { mtimeMs } = await stat(file);
      if (nowMs - mtimeMs > IMPERSONATION_REPLAY_WINDOW_SEC * 1000) await unlink(file);
    } catch {
      // Another process pruned it first.
    }
  }
}

/**
 * Record an impersonation token's jti as used; false when it was used before
 * or the use can't be recorded.
 *
 * The in-process cache alone forgot every jti on restart and knew nothing of
 * other replicas, so a captured handoff link could be redeemed again within
 * its lifetime. Each jti also gets a marker file in the state directory,
 * created with O_EXCL, which survives restarts and is shared by every
 * replica that mounts the same state volume. Markers are pruned once the
 * token they stand for can no longer verify. With a shared store the marker
 * is a document there, created only if missing, so exactly one replica
 * accepts the token.
 */
export async function consumeImpersonationJti(
  jti: string,
  exp: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!impersonationReplayCache.consume(jti, exp, Math.floor(nowMs / 1000))) return false;

  if (isSharedMode()) {
    try {
      return (await impersonationJtiCollection().put(markerName(jti), '', { ifVersion: null })).ok;
    } catch (err) {
      logger.error('Impersonation replay store unavailable, refusing the token', {
        error: err instanceof Error ? err.message : 'Unknown',
      });
      return false;
    }
  }

  const dir = getStatePath(STORE_DIR);
  try {
    await mkdir(dir, { recursive: true });
    await pruneExpired(dir, nowMs);
    const marker = await open(path.join(dir, markerName(jti)), 'wx');
    await marker.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // Without the marker a restart or another replica would accept the
    // token again, so it is refused rather than trusted to this process's
    // memory.
    logger.error('Impersonation replay store unavailable, refusing the token', {
      error: err instanceof Error ? err.message : 'Unknown',
    });
    return false;
  }
}
