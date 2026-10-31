import type { ImportStep } from '../import';
import { getStore, type CollectionOptions } from '../index';
import { localCollection, localLog } from '../local';
import {
  ADMIN_CONFIG_COLLECTION,
  ADMIN_STATE_COLLECTION,
  adminConfigOptions,
  adminStateOptions,
} from '@/lib/admin/admin-store';
import { AUDIT_LOG_OPTIONS } from '@/lib/admin/audit';

/**
 * Part `admin` of the import (#1066): the admin config, the admin password
 * and its state, and the audit log of a single-instance install. Reads the
 * local files as local mode does and writes only what the shared store
 * doesn't hold yet. With ADMIN_CONFIG_READONLY the config collection is the
 * mounted files on every replica, so nothing of it is copied.
 */

async function copyDocs(name: string, options: CollectionOptions, ids: string[]): Promise<number> {
  const local = localCollection(name, options);
  const shared = getStore().collection(name, options);
  let written = 0;
  for (const id of ids) {
    const doc = await local.get(id);
    if (!doc) continue;
    if ((await shared.put(id, doc.data, { ifVersion: null })).ok) written++;
  }
  return written;
}

export const steps: ImportStep[] = [
  {
    name: 'admin-config',
    run: () => copyDocs(ADMIN_CONFIG_COLLECTION, adminConfigOptions, ['config.json', 'policy.json', 'admin.json', '.config-locked']),
  },
  {
    name: 'admin-state',
    run: () => copyDocs(ADMIN_STATE_COLLECTION, adminStateOptions, ['admin-state.json']),
  },
  {
    // The current audit.log, as the dashboard shows it; the rotated files
    // stay on disk. Only into an empty shared log, so a second run (or a
    // replica that joins later) adds nothing twice.
    name: 'audit',
    run: async () => {
      const shared = getStore().log('audit', AUDIT_LOG_OPTIONS);
      if ((await shared.length()) > 0) return 0;
      const lines = (await localLog('audit', AUDIT_LOG_OPTIONS).readAll()).slice(-AUDIT_LOG_OPTIONS.maxEntries);
      for (const line of lines) await shared.append(line);
      return lines.length;
    },
  },
];
