import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';
import { readBodyCapped } from '@/lib/security/capped-body';
import { configManager } from '@/lib/admin/config-manager';
import { feedForSubject, feedHostname } from '@/lib/admin/company-feeds';
import { companyFeedCache } from '@/lib/admin/company-feed-cache';
import { serverPolicySubject } from '@/lib/admin/server-policy-subject';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25MB
// Base budget for a default-sized feed; scaled up with the configured cap so a
// larger allowed body is not cut off by the timer that fit the smaller one.
const BASE_TIMEOUT_MS = 15000;

/** Response cap from ICAL_MAX_BYTES (bytes), read per request so a deploy can raise it. (#692) */
function getMaxResponseSize(): number {
  const raw = process.env.ICAL_MAX_BYTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function getFetchTimeoutMs(maxBytes: number): number {
  return Math.max(BASE_TIMEOUT_MS, Math.ceil(BASE_TIMEOUT_MS * (maxBytes / DEFAULT_MAX_BYTES)));
}

function tooLarge(maxBytes: number) {
  const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return NextResponse.json(
    { error: `Calendar feed is larger than the ${limitMb} MB limit (ICAL_MAX_BYTES)` },
    { status: 413 },
  );
}

function extractBasicAuth(rawUrl: string): { cleanUrl: string; authHeader: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  let authHeader: string | null = null;
  if (parsed.username || parsed.password) {
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    parsed.username = '';
    parsed.password = '';
  }

  return { cleanUrl: parsed.toString(), authHeader };
}

type FetchOutcome =
  | { kind: 'ok'; buffer: ArrayBuffer; etag: string | null; lastModified: string | null }
  | { kind: 'not-modified' }
  | { kind: 'error'; response: NextResponse };

/**
 * Fetch one feed. Every hop, redirect targets included, goes through
 * `fetchPublicUrl`, which validates the resolved address inside the socket
 * lookup so a rebinding DNS server cannot steer the connection at an
 * internal host (GHSA-24w9-8r42-8jwm). `allowPrivateHost` lifts that for the
 * one hostname of a company calendar the admin entered (an intranet host).
 */
async function fetchIcal(
  url: string,
  options: { allowPrivateHost?: string; etag?: string | null; lastModified?: string | null } = {},
): Promise<FetchOutcome> {
  const fail = (error: string, status: number): FetchOutcome => ({ kind: 'error', response: NextResponse.json({ error }, { status }) });
  const extracted = extractBasicAuth(url);
  if (!extracted) return fail('Invalid or disallowed URL', 400);

  const { cleanUrl, authHeader } = extracted;

  const maxResponseSize = getMaxResponseSize();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getFetchTimeoutMs(maxResponseSize));

  try {
    const MAX_REDIRECTS = 5;
    let currentUrl = cleanUrl;
    const originalOrigin = new URL(cleanUrl).origin;
    let response: PublicFetchResponse | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = {
        'Accept': 'text/calendar, application/ics, text/plain, */*',
        'User-Agent': 'Bulwark-Webmail-Calendar (+https://bulwarkmail.org)',
      };
      if (authHeader && new URL(currentUrl).origin === originalOrigin) {
        headers['Authorization'] = authHeader;
      }
      if (options.etag) headers['If-None-Match'] = options.etag;
      if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;

      try {
        const init = { signal: controller.signal, headers };
        response = options.allowPrivateHost
          ? await fetchPublicUrl(currentUrl, init, { allowPrivateHost: options.allowPrivateHost })
          : await fetchPublicUrl(currentUrl, init);
      } catch (error) {
        if (error instanceof DisallowedUrlError) {
          return fail(i === 0 ? 'Invalid or disallowed URL' : 'Redirect to disallowed URL', 400);
        }
        throw error;
      }

      if (response.status === 304 && (options.etag || options.lastModified)) {
        return { kind: 'not-modified' };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return fail('Redirect without Location header', 502);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      return fail(`Remote server returned ${response?.status ?? 'unknown'}`, 502);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > maxResponseSize) {
      return { kind: 'error', response: tooLarge(maxResponseSize) };
    }

    // Read up to the cap and no further: a chunked body with no
    // Content-Length used to be buffered whole before it was measured, so a
    // feed that streams for the whole timeout could take the process's
    // memory with it.
    const buffer = await readBodyCapped(response, maxResponseSize, controller);
    if (!buffer) {
      return { kind: 'error', response: tooLarge(maxResponseSize) };
    }
    return { kind: 'ok', buffer, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return fail('Request timed out', 504);
    }
    return fail('Failed to fetch calendar', 502);
  } finally {
    clearTimeout(timeout);
  }
}

function icalResponse(buffer: ArrayBuffer): NextResponse {
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar',
      'Content-Length': buffer.byteLength.toString(),
    },
  });
}

/**
 * A company calendar by id (organisation.calendars.feeds). The address comes
 * from the caller's own scoped policy, with their groups read from their
 * JMAP session here, so the browser never sees it and can't ask for the
 * feed of a scope it isn't in. A feed is kept per address for its refresh
 * interval, so many users cost one fetch, and asked again with
 * If-None-Match / If-Modified-Since. A feed that can't be fetched keeps
 * answering with what it last had.
 */
async function fetchCompanyFeed(creds: StalwartCredentials, feedId: string): Promise<NextResponse> {
  await configManager.ensureLoaded();
  const subject = await serverPolicySubject(creds);
  const feed = feedForSubject(configManager.getPolicy(), subject, feedId);
  if (!feed) {
    return NextResponse.json({ error: 'Unknown calendar' }, { status: 404 });
  }
  const cached = companyFeedCache.get(feed.url);
  if (cached && Date.now() - cached.fetchedAt < feed.refreshMinutes * 60_000) {
    return icalResponse(cached.body);
  }
  const outcome = await fetchIcal(feed.url, {
    allowPrivateHost: feedHostname(feed) ?? undefined,
    etag: cached?.etag,
    lastModified: cached?.lastModified,
  });
  if (outcome.kind === 'ok') {
    companyFeedCache.set(feed.url, { body: outcome.buffer, etag: outcome.etag, lastModified: outcome.lastModified, fetchedAt: Date.now() });
    return icalResponse(outcome.buffer);
  }
  if (cached) {
    if (outcome.kind === 'not-modified') companyFeedCache.set(feed.url, { ...cached, fetchedAt: Date.now() });
    return icalResponse(cached.body);
  }
  return outcome.kind === 'error'
    ? outcome.response
    : NextResponse.json({ error: 'Failed to fetch calendar' }, { status: 502 });
}

/**
 * POST /api/fetch-ical
 *
 * Server-side proxy for iCalendar subscription URLs (the browser cannot fetch
 * them directly because of CORS), `{ url }`, and for company calendars by
 * id, `{ feedId }`. Only logged-in users may use it.
 */
export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { url?: string; feedId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (body && body.feedId !== undefined) {
    if (typeof body.feedId !== 'string' || !body.feedId) {
      return NextResponse.json({ error: 'Unknown calendar' }, { status: 404 });
    }
    return fetchCompanyFeed(creds, body.feedId);
  }

  const { url } = body ?? {};

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const outcome = await fetchIcal(url);
  if (outcome.kind === 'ok') return icalResponse(outcome.buffer);
  if (outcome.kind === 'error') return outcome.response;
  return NextResponse.json({ error: 'Failed to fetch calendar' }, { status: 502 });
}
