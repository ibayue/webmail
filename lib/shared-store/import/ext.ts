import { readFile } from 'node:fs/promises';
import type { ImportStep } from '../import';
import { getStore, type CollectionOptions } from '../index';
import { localCollection } from '../local';
import {
  BRANDING_COLLECTION,
  DIRECTORY_KEYRINGS_ID,
  PLUGIN_APPROVALS_COLLECTION,
  PLUGIN_CONFIG_COLLECTION,
  PLUGINS_COLLECTION,
  THEMES_COLLECTION,
  brandingOptions,
  directoryKeyringsOptions,
  pluginApprovalsOptions,
  pluginConfigOptions,
  pluginsOptions,
  themesOptions,
} from '@/lib/admin/extension-store';
import { ADMIN_STATE_COLLECTION } from '@/lib/admin/admin-store';
import { SHARED_KEY_NAME } from '@/lib/admin/plugin-signing';
import { getConfigPath } from '@/lib/admin/paths';

/**
 * Part `ext` of the import (#1066): installed plugins and themes (registry,
 * bundles, signatures, CSS, kept history), plugin config, plugin approvals
 * and the packages sent with them, the plugin signing key, the directory
 * keyring dates and the branding uploads of a single-instance install.
 * Reads the local files as local mode does and writes only what the shared
 * store doesn't hold yet. With ADMIN_CONFIG_READONLY the config-dir
 * collections are the mounted files on every replica, so nothing of them is
 * copied (the put finds the file already there).
 */

/** Every document under `prefix` of a collection. */
function copyCollection(name: string, options: CollectionOptions, prefix = '', only?: (id: string) => boolean): ImportStep {
  return {
    name,
    async run() {
      const local = localCollection(name, options);
      const shared = getStore().collection(name, options);
      let written = 0;
      for (const id of await local.list(prefix)) {
        if (only && !only(id)) continue;
        const doc = await local.get(id);
        if (!doc) continue;
        if ((await shared.put(id, doc.data, { ifVersion: null })).ok) written++;
      }
      return written;
    },
  };
}

export const steps: ImportStep[] = [
  copyCollection(PLUGINS_COLLECTION, pluginsOptions),
  copyCollection(THEMES_COLLECTION, themesOptions),
  copyCollection(PLUGIN_CONFIG_COLLECTION, pluginConfigOptions, '', (id) => id.endsWith('.json') && !id.includes('/')),
  // plugin-approvals.json and plugin-approvals/<id>-<hash>.zip, both under C.
  copyCollection(PLUGIN_APPROVALS_COLLECTION, pluginApprovalsOptions, 'plugin-approvals',
    (id) => id === 'plugin-approvals.json' || /^plugin-approvals\/[^/]+\.zip$/.test(id)),
  copyCollection(BRANDING_COLLECTION, brandingOptions, '', (id) => !id.includes('/')),
  {
    name: 'directory-keyrings',
    async run() {
      const doc = await localCollection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions).get(DIRECTORY_KEYRINGS_ID);
      if (!doc) return 0;
      const shared = getStore().collection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions);
      return (await shared.put(DIRECTORY_KEYRINGS_ID, doc.data, { ifVersion: null })).ok ? 1 : 0;
    },
  },
  {
    // The generated key in C/plugin-signing.key, so bundles signed before
    // the move keep verifying. PLUGIN_SIGNING_KEY_FILE, when set, still wins
    // over the stored key on every replica.
    name: 'plugin-signing-key',
    async run() {
      let pem: string;
      try {
        pem = await readFile(getConfigPath('plugin-signing.key'), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      if (!pem.includes('-----BEGIN PRIVATE KEY-----')) return 0;
      return (await getStore().kv.set(SHARED_KEY_NAME, pem, { ifAbsent: true })) ? 1 : 0;
    },
  },
];
