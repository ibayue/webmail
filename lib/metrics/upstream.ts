import { observeUpstreamResult, type UpstreamTarget } from './index';

/**
 * Run one request this server makes to another service and record its
 * duration and outcome under a fixed target name. An answer below 500 counts
 * as ok (a 401 from Stalwart is an answer); a 5xx or a thrown error as
 * error. Costs nothing while metrics are off.
 */
export async function observeUpstream<T extends { status: number }>(target: UpstreamTarget, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const response = await run();
    observeUpstreamResult(target, response.status < 500, (performance.now() - start) / 1000);
    return response;
  } catch (error) {
    observeUpstreamResult(target, false, (performance.now() - start) / 1000);
    throw error;
  }
}
