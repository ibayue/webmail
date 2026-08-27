import { NextRequest, NextResponse } from 'next/server';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 15000;

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

/**
 * POST /api/fetch-ical
 *
 * Server-side proxy for iCalendar subscription URLs (the browser cannot fetch
 * them directly because of CORS). Only logged-in users may use it, and every
 * hop - including redirect targets - goes through `fetchPublicUrl`, which
 * validates the resolved address inside the socket lookup so a rebinding DNS
 * server cannot steer the connection at an internal host
 * (GHSA-24w9-8r42-8jwm).
 */
export async function POST(request: NextRequest) {
  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url } = body;

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const extracted = extractBasicAuth(url);
  if (!extracted) {
    return NextResponse.json({ error: 'Invalid or disallowed URL' }, { status: 400 });
  }

  const { cleanUrl, authHeader } = extracted;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const MAX_REDIRECTS = 5;
    let currentUrl = cleanUrl;
    const originalOrigin = new URL(cleanUrl).origin;
    let response: PublicFetchResponse | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = {
        'Accept': 'text/calendar, application/ics, text/plain, */*',
        'User-Agent': 'JMAP-Webmail/1.0 Calendar-Fetcher',
      };
      if (authHeader && new URL(currentUrl).origin === originalOrigin) {
        headers['Authorization'] = authHeader;
      }

      try {
        response = await fetchPublicUrl(currentUrl, {
          signal: controller.signal,
          headers,
        });
      } catch (error) {
        if (error instanceof DisallowedUrlError) {
          return NextResponse.json(
            { error: i === 0 ? 'Invalid or disallowed URL' : 'Redirect to disallowed URL' },
            { status: 400 },
          );
        }
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return NextResponse.json({ error: 'Redirect without Location header' }, { status: 502 });
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      return NextResponse.json(
        { error: `Remote server returned ${response?.status ?? 'unknown'}` },
        { status: 502 }
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 });
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 });
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar',
        'Content-Length': buffer.byteLength.toString(),
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timed out' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Failed to fetch calendar' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
