// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A company calendar may live on the intranet: fetchPublicUrl lets exactly
// the host the admin entered resolve to a private address, and nothing else
// (a redirect to another private host, another name), with the address still
// pinned at connect time.

const lookup = vi.fn();
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

describe('fetchPublicUrl with allowPrivateHost', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    hits = 0;
  });

  it('reaches the admin\'s intranet host', async () => {
    const { fetchPublicUrl } = await import('@/lib/security/url-guard');
    const res = await fetchPublicUrl(`http://cal.intranet.example:${port}/team.ics`, {}, { allowPrivateHost: 'cal.intranet.example' });
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
  });

  it('allows .internal names only for that host', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    const res = await fetchPublicUrl(`http://calendar.corp.internal:${port}/a.ics`, {}, { allowPrivateHost: 'calendar.corp.internal' });
    expect(res.status).toBe(200);
    await expect(fetchPublicUrl(`http://other.corp.internal:${port}/a.ics`, {}, { allowPrivateHost: 'calendar.corp.internal' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
  });

  it('keeps refusing every other host that resolves to a private address', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    await expect(fetchPublicUrl(`http://rebind.example:${port}/cal.ics`, {}, { allowPrivateHost: 'cal.intranet.example' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    await expect(fetchPublicUrl(`http://cal.intranet.example:${port}/team.ics`)).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(hits).toBe(0);
  });
});
