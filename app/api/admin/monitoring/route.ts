import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { readErrors, summarizeDay, utcDay } from '@/lib/error-reporting/aggregate';
import { shouldCollectErrors } from '@/lib/error-reporting/settings';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/monitoring: what System > Monitoring shows besides the
 * config keys (those come from /api/admin/config): whether errors are being
 * counted and today's counts.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    const collecting = await shouldCollectErrors();
    const today = utcDay();
    const errorsToday = summarizeDay(await readErrors(), today);
    return NextResponse.json({ collecting, day: today, errorsToday }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.error('monitoring GET error', { error: err instanceof Error ? err.message : 'unknown' });
    const unavailable = storedDataUnavailableResponse(err);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
