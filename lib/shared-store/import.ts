import type { ImportSummary } from './boot';

/**
 * Copy an existing single-instance install's local files into an
 * uninitialised shared store (#1066). Every store brings its own steps (in
 * lib/shared-store/import/<part>.ts); each step reads that store's local
 * files exactly as local mode would and writes only what the store doesn't
 * hold yet (put with ifVersion: null), so running it again changes nothing.
 * It never changes or deletes a local file. Returns how many items it wrote.
 */
export interface ImportStep {
  name: string;
  run(): Promise<number>;
}

const STEPS: ImportStep[] = [];

export async function importLocalData(steps: ImportStep[] = STEPS): Promise<ImportSummary> {
  const imported: Record<string, number> = {};
  for (const step of steps) imported[step.name] = await step.run();
  return { imported };
}
