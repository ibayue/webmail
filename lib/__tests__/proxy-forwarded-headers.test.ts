/**
 * @vitest-environment node
 *
 * Next forwards ONLY the request headers a middleware lists in
 * `x-middleware-override-headers` and deletes every other one before the
 * route sees the request. proxy() used to list just x-nonce/x-pathname on a
 * bare NextResponse.next(), which stripped RSC, Next-Router-State-Tree,
 * Next-Url, Cookie, ... from every page that skips the intl middleware. Since
 * Next 16.3 the server validates the `_rsc` cache-busting hash against those
 * router headers and 307s on a mismatch, so each navigation and prefetch of a
 * locale-prefixed page looped through 307/200 for about a second (#919).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getPolicy: vi.fn(() => ({ features: {} })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
// next-intl's ESM middleware build can't be loaded under vitest's node
// resolver (it imports the bare "next/server" specifier). Stand in with the
// behaviour that matters here: it rewrites to the locale-prefixed path and
// forwards the FULL request header set, tagged with the resolved locale.
// With localePrefix "always" it redirects to the prefixed path instead.
let intlMode: 'rewrite' | 'redirect' = 'rewrite';
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    default: () => (request: Request) => {
      const url = new URL(request.url);
      url.pathname = `/en${url.pathname}`;
      if (intlMode === 'redirect') return NextResponse.redirect(url);
      const headers = new Headers(request.headers);
      headers.set('x-next-intl-locale', 'en');
      return NextResponse.rewrite(url, { request: { headers } });
    },
  };
});

import { proxy } from '@/proxy';

const ROUTER_HEADERS = {
  rsc: '1',
  'next-router-state-tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22(main)%22%5D%7D%5D',
  'next-url': '/en',
  'next-router-prefetch': '1',
  cookie: 'jmap_session_0=abc',
  'accept-language': 'de-DE,de;q=0.9',
};

function forwardedHeaderNames(response: Response): Set<string> {
  return new Set(
    (response.headers.get('x-middleware-override-headers') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function nonceFromCsp(response: Response): string | undefined {
  return /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  intlMode = 'rewrite';
});

describe('proxy forwards the request headers it does not own (#919)', () => {
  it.each([
    ['a locale-prefixed page (intl middleware skipped)', 'http://localhost:3000/en/calendar?_rsc=abc12', '/en/calendar'],
    ['the locale root', 'http://localhost:3000/en?_rsc=abc12', '/en'],
    ['an admin page', 'http://localhost:3000/admin/plugins', '/admin/plugins'],
    ['a protocol handler page', 'http://localhost:3000/protocol/mailto?url=mailto%3Aa%40b.c', '/protocol/mailto'],
  ])('keeps the router, cookie and language headers on %s', async (_label, url, pathname) => {
    const response = await proxy(new NextRequest(url, { headers: ROUTER_HEADERS }));

    const forwarded = forwardedHeaderNames(response);
    for (const name of Object.keys(ROUTER_HEADERS)) {
      expect(forwarded, `${name} must stay on the request`).toContain(name);
      expect(response.headers.get(`x-middleware-request-${name}`)).toBe(ROUTER_HEADERS[name as keyof typeof ROUTER_HEADERS]);
    }
    // The two headers the proxy adds for the server components.
    expect(forwarded).toContain('x-nonce');
    expect(forwarded).toContain('x-pathname');
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe(pathname);
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceFromCsp(response));
    // Not a redirect: the route renders, the RSC hash check sees its headers.
    expect(response.status).toBe(200);
  });

  it('only appends its own headers when the intl middleware already listed the request headers', async () => {
    // Unprefixed path (localePrefix "never" in the test env): next-intl
    // rewrites it and forwards the full header set itself, tagged with the
    // resolved locale.
    const response = await proxy(new NextRequest('http://localhost:3000/calendar?_rsc=abc12', { headers: ROUTER_HEADERS }));

    const forwarded = forwardedHeaderNames(response);
    expect(forwarded).toContain('x-next-intl-locale');
    for (const name of Object.keys(ROUTER_HEADERS)) expect(forwarded).toContain(name);
    expect(forwarded).toContain('x-nonce');
    expect(forwarded).toContain('x-pathname');
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/calendar');
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceFromCsp(response));
    // Each name once - Next builds a Set, but keep the header tidy.
    const raw = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(new Set(raw).size).toBe(raw.length);
  });

  it('leaves a locale redirect alone - no route renders, nothing to forward', async () => {
    intlMode = 'redirect';
    const response = await proxy(new NextRequest('http://localhost:3000/calendar', { headers: ROUTER_HEADERS }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/en/calendar');
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
    expect(response.headers.get('x-middleware-request-cookie')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
  });
});
