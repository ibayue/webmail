import type { ImportSummary } from './boot';

/**
 * Copy an existing single-instance install's local files into an
 * uninitialised shared store (#1066). Every store adds its own step here;
 * each step writes only what the store doesn't hold yet (put with
 * ifVersion: null), so running it again changes nothing, and it never
 * changes or deletes a local file.
 */
export async function importLocalData(): Promise<ImportSummary> {
  const imported: Record<string, number> = {};
  return { imported };
}
