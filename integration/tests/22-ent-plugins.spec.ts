import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import {
  ENT,
  adminContext,
  deliver,
  getPolicy,
  jmapAs,
  putPolicy,
  requireEntEnv,
  shot,
  userPage,
} from './helpers/ent';

/**
 * Enterprise pack, package E (official plugins and the host API they need),
 * through the real UI on a VM 106 test Stalwart with the ent-* accounts:
 * - item 4: external-link-warning 2.0.0 asks a company link-check service
 *   (a mock started by this spec) at click time: an "unsafe" verdict warns,
 *   a "safe" link opens, the dialog names the real target domain, a service
 *   that is down follows the admin's fail-open / fail-closed choice, and the
 *   service stays reachable with "no third-party traffic" on;
 * - item 5: send-checks 1.0.0 warns about an IBAN or a card number, blocks a
 *   blocked rule, ignores internal recipients for an external-only rule
 *   (with an organisation domain set in a group scope only), refuses a
 *   disallowed attachment type, and runs on quick reply too;
 * - both dialogs at 390 px, and the send-checks admin page.
 *
 * Both plugins are installed from the local builds of the plugins worktree
 * (IT_PLUGINS_DIR) through the admin API and removed at the end. The server
 * must run with PLUGIN_PROXY_PRIVATE_ORIGINS=http://127.0.0.1:3195 (the
 * mock is plain HTTP on this PC) and NEXT_PUBLIC_APP_VERSION=1.20.0 (both
 * plugins need 1.20.0). No request goes to Google: the lookup mode is
 * "endpoint", the Safe Browsing key is a fake.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const PLUGINS_DIR = process.env.IT_PLUGINS_DIR ?? 'C:/Users/info/worktrees/plugins-enterprise';
const LINK_ZIP = `${PLUGINS_DIR}/external-link-warning/external-link-warning.zip`;
const SEND_ZIP = `${PLUGINS_DIR}/send-checks/send-checks.zip`;
const LINK = 'external-link-warning';
const SEND = 'send-checks';
const MOCK_PORT = 3195;
const TOKEN = 'it-link-check-token';
const RUN = Date.now().toString(36);
const LINK_HOST = 'ent-link.example.org';

let original: Record<string, unknown>;
let mock: Server;
const endpoint = { up: true, requests: [] as { url: string; host: string; auth: string }[] };

// ─── Setup ───────────────────────────────────────────────────

async function installPlugin(admin: BrowserContext, id: string, zip: string): Promise<void> {
  await admin.request.delete('/api/admin/plugins', { data: { id } });
  const installed = await admin.request.post('/api/admin/plugins', {
    multipart: { file: { name: `${id}.zip`, mimeType: 'application/zip', buffer: readFileSync(zip) } },
  });
  expect(installed.ok(), await installed.text()).toBe(true);
}

async function setConfig(browser: Browser, id: string, values: Record<string, unknown>): Promise<void> {
  const admin = await adminContext(browser);
  for (const [key, value] of Object.entries(values)) {
    const res = await admin.request.put(`/api/admin/plugins/${id}/config`, { data: { key, value } });
    expect(res.ok(), `${id}.${key}: ${await res.text()}`).toBe(true);
  }
  await admin.close();
}

async function setPolicy(browser: Browser, patch: Record<string, unknown>): Promise<void> {
  const admin = await adminContext(browser);
  await putPolicy(admin, { ...original, ...patch });
  await admin.close();
}

function startMock(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (!endpoint.up) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"down"}');
          return;
        }
        let parsed: { url?: string; host?: string } = {};
        try { parsed = JSON.parse(body); } catch { /* bad request below */ }
        endpoint.requests.push({ url: parsed.url ?? '', host: parsed.host ?? '', auth: String(req.headers.authorization ?? '') });
        const unsafe = (parsed.url ?? '').includes('/unsafe');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(unsafe
          ? { verdict: 'unsafe', reason: 'Known phishing page', cacheSeconds: 0 }
          : { verdict: 'safe', cacheSeconds: 0 }));
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  requireEntEnv();
  test.skip(!existsSync(LINK_ZIP) || !existsSync(SEND_ZIP), `build the plugins first: ${LINK_ZIP}, ${SEND_ZIP}`);
  mock = await startMock();
  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  await admin.request.get('/plugin-sandbox', { timeout: 120_000 });
  await installPlugin(admin, LINK, LINK_ZIP);
  await installPlugin(admin, SEND, SEND_ZIP);
  const features = { ...(original.features as Record<string, unknown>), pluginsEnabled: true };
  const forced = [...new Set([...((original.forceEnabledPlugins as string[] | undefined) ?? []), LINK, SEND])];
  original = { ...original, features, forceEnabledPlugins: forced };
  await putPolicy(admin, original);
  await admin.close();
  await setConfig(browser, LINK, {
    trustedDomains: '',
    lookup: 'endpoint',
    endpointUrl: `http://127.0.0.1:${MOCK_PORT}/check`,
    endpointToken: TOKEN,
    // A fake: the lookup mode never asks Google.
    safeBrowsingKey: 'it-fake-safe-browsing-key',
    onFailure: 'open',
    onUnsafe: 'warn',
    skipTrusted: true,
  });
  await setConfig(browser, SEND, {
    ibanAction: 'warn', ibanExternalOnly: false,
    cardAction: 'warn', cardExternalOnly: false,
    keywords: `TOPSECRET-${RUN}`, keywordAction: 'block', keywordExternalOnly: false,
    patterns: '', patternAction: 'warn', patternExternalOnly: false,
    blockedTypes: 'exe, bat, application/x-msdownload', allowedTypes: '', maxSizeMb: 0,
    attachmentAction: 'block', attachmentExternalOnly: false,
  });
});

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000);
  mock?.close();
  // Our messages go, in every ent account the spec wrote to.
  for (const account of [ENT.alice, ENT.bob, ENT.carol]) {
    const client = await jmapAs(account);
    const r = await client.request([['Email/query', { accountId: client.accountId, filter: { text: RUN }, limit: 100 }, '0']]);
    const ids = r.methodResponses?.[0]?.[1]?.ids ?? [];
    if (ids.length) await client.request([['Email/set', { accountId: client.accountId, destroy: ids }, '0']]).catch(() => {});
  }
  if (!original) return;
  const admin = await adminContext(browser);
  const forced = ((original.forceEnabledPlugins as string[] | undefined) ?? []).filter((id) => id !== LINK && id !== SEND);
  await putPolicy(admin, { ...original, forceEnabledPlugins: forced });
  await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: false } }).catch(() => {});
  await admin.request.delete('/api/admin/plugins', { data: { id: LINK } });
  await admin.request.delete('/api/admin/plugins', { data: { id: SEND } });
  await admin.close();
});

// ─── Helpers ─────────────────────────────────────────────────

async function messages(account: string, needle: string): Promise<{ id: string; subject: string }[]> {
  const client = await jmapAs(account);
  const r = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { text: needle }, limit: 50 }, '0'],
    ['Email/get', { accountId: client.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, '1'],
  ]);
  return r.methodResponses[1][1].list;
}

async function waitForMessage(account: string, subject: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await messages(account, RUN)).some((m) => m.subject === subject)) {
    if (Date.now() > deadline) throw new Error(`${account}: no "${subject}"`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Nothing with `subject` arrived within a few seconds. */
async function expectNotSent(account: string, subject: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 4000));
  expect((await messages(account, RUN)).filter((m) => m.subject === subject)).toEqual([]);
}

/** Both plugins started: their background frames are there, and a moment for init. */
async function pluginsReady(page: Page): Promise<void> {
  await expect(page.locator('iframe[src*="/plugin-sandbox"]')).toHaveCount(2, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = page.locator('[data-testid="email-list-item"], [data-thread-keys]', { hasText: subject }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: subject }).first()).toBeVisible({ timeout: 20_000 });
}

const linkDialog = (page: Page) => page.locator(`[data-plugin-dialog="${LINK}"]`);
const sendDialog = (page: Page) => page.locator(`[data-plugin-dialog="${SEND}"]`);
// The message body: the reader's iframe carries the mail in srcdoc (plugin frames load a URL).
const body = (page: Page) => page.frameLocator('iframe[srcdoc]:visible').first();

/** Answers every request to the test link host, so an opened tab lands somewhere. */
async function routeLinks(context: BrowserContext): Promise<void> {
  await context.route(`https://*.${LINK_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Target</h1>' }));
}

/** A mail to ent-alice with the three links. */
async function deliverLinks(subject: string): Promise<void> {
  await deliver({
    from: ENT.bob,
    to: [ENT.alice],
    subject,
    text: 'Links',
    html: [
      `<p><a href="https://bad.${LINK_HOST}/unsafe/${RUN}">https://bank.example.com/login</a></p>`,
      `<p><a href="https://good.${LINK_HOST}/safe/${RUN}">Safe page</a></p>`,
    ].join(''),
  });
  await waitForMessage(ENT.alice, subject);
}

async function compose(page: Page, to: string[], subject: string, text: string): Promise<void> {
  await page.keyboard.press('c');
  const composer = page.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = page.locator('[data-testid="composer-to"] input').first();
  for (const address of to) {
    await input.click();
    await input.fill(address);
    await input.press('Enter');
  }
  await page.locator('[data-testid="composer-subject"]').first().fill(subject);
  await composer.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(text);
}

async function pressSend(page: Page): Promise<void> {
  await page.locator('[data-testid="composer-subject"]').first().focus();
  await page.keyboard.press('Control+Enter');
}

const IBAN = 'DE89 3704 0044 0532 0130 00';
const CARD = '4242 4242 4242 4242';

// ─── Item 4: link check ──────────────────────────────────────

test('item 4: an unsafe verdict warns, with the real target domain and what the link text claims', async ({ browser }) => {
  const subject = `Links unsafe ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  endpoint.requests = [];
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('This link may be dangerous');
  await expect(dialog).toContainText(`bad.${LINK_HOST}`);
  await expect(dialog).toContainText('Known phishing page');
  await expect(dialog).toContainText(`The link text says bank.example.com, but the link goes to bad.${LINK_HOST}.`);
  // The service got the full URL, with the admin's token.
  expect(endpoint.requests).toEqual([{ url: `https://bad.${LINK_HOST}/unsafe/${RUN}`, host: `bad.${LINK_HOST}`, auth: `Bearer ${TOKEN}` }]);
  await shot(alice, 'e-link-unsafe');
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(dialog).toBeHidden();
  expect(alice.context().pages()).toHaveLength(1);
  await alice.context().close();
});

test('item 4: a safe link opens after the domain warning, and a middle-click goes through the check too', async ({ browser }) => {
  const subject = `Links safe ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  await body(alice).getByRole('link', { name: 'Safe page' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toContainText('Open external link?', { timeout: 20_000 });
  await expect(dialog).toContainText(`good.${LINK_HOST}`);
  await expect(dialog).toContainText('Checked: no known threats.');
  const opened = alice.context().waitForEvent('page');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  // "Always trust" comes next; this once only.
  const trust = linkDialog(alice).getByRole('button', { name: 'Just this once' });
  await trust.click({ timeout: 10_000 }).catch(() => {});
  const tab = await opened;
  expect(tab.url()).toBe(`https://good.${LINK_HOST}/safe/${RUN}`);
  await tab.close();

  // A middle-click used to open the link in a new tab with no check.
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click({ button: 'middle' });
  await expect(linkDialog(alice)).toContainText('This link may be dangerous', { timeout: 20_000 });
  await linkDialog(alice).getByRole('button', { name: 'Go back' }).click();
  expect(alice.context().pages()).toHaveLength(1);
  await alice.context().close();
});

test('item 4: with the service down, fail open lets the user go on and fail closed does not', async ({ browser }) => {
  const subject = `Links down ${RUN}`;
  await deliverLinks(subject);
  endpoint.up = false;
  try {
    const alice = await userPage(browser, ENT.alice);
    await routeLinks(alice.context());
    await pluginsReady(alice);
    await openMessage(alice, subject);
    await body(alice).getByRole('link', { name: 'Safe page' }).click();
    const dialog = linkDialog(alice);
    await expect(dialog).toContainText("Couldn't check this link.", { timeout: 20_000 });
    await expect(dialog).toContainText(`good.${LINK_HOST}`);
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await shot(alice, 'e-link-fail-open');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await alice.context().close();

    await setConfig(browser, LINK, { onFailure: 'closed' });
    const again = await userPage(browser, ENT.alice);
    await routeLinks(again.context());
    await pluginsReady(again);
    await openMessage(again, subject);
    await body(again).getByRole('link', { name: 'Safe page' }).click();
    const closed = linkDialog(again);
    await expect(closed).toContainText("Link couldn't be checked", { timeout: 20_000 });
    await expect(closed).toContainText(`good.${LINK_HOST}`);
    await expect(closed.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await shot(again, 'e-link-fail-closed');
    await closed.getByRole('button', { name: 'Close' }).click();
    expect(again.context().pages()).toHaveLength(1);
    await again.context().close();
  } finally {
    endpoint.up = true;
    await setConfig(browser, LINK, { onFailure: 'open' });
  }
});

test('item 4: with no third-party traffic the company service still answers, and Security lists it', async ({ browser }) => {
  const subject = `Links mode ${RUN}`;
  await deliverLinks(subject);
  const admin = await adminContext(browser);
  const on = await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: true } });
  expect(on.ok(), await on.text()).toBe(true);
  try {
    const page = await admin.newPage();
    await page.goto('/admin/org-security');
    const reachable = page.getByTestId('third-party-reachable');
    await expect(reachable).toContainText(`127.0.0.1:${MOCK_PORT}`, { timeout: 20_000 });
    await expect(reachable).toContainText('Plugin External Link Warning');
    await expect(page.locator('[data-settings-section="third-party"]')).toContainText('safebrowsing.googleapis.com stays off');
    await shot(page, 'e-link-admin-security');

    const alice = await userPage(browser, ENT.alice);
    await routeLinks(alice.context());
    await pluginsReady(alice);
    await openMessage(alice, subject);
    endpoint.requests = [];
    await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
    await expect(linkDialog(alice)).toContainText('This link may be dangerous', { timeout: 20_000 });
    expect(endpoint.requests).toHaveLength(1);
    await linkDialog(alice).getByRole('button', { name: 'Go back' }).click();
    await alice.context().close();
  } finally {
    await admin.request.patch('/api/admin/config', { data: { noThirdPartyTraffic: false } });
    await admin.close();
  }
});

test('item 4: the link dialog fits at 390 px', async ({ browser }) => {
  const subject = `Links phone ${RUN}`;
  await deliverLinks(subject);
  const alice = await userPage(browser, ENT.alice, true);
  await routeLinks(alice.context());
  await pluginsReady(alice);
  await openMessage(alice, subject);
  await body(alice).getByRole('link', { name: 'https://bank.example.com/login' }).click();
  const dialog = linkDialog(alice);
  await expect(dialog).toContainText('This link may be dangerous', { timeout: 20_000 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(alice, 'e-link-phone');
  await alice.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await alice.context().close();
});

// ─── Item 5: send checks ─────────────────────────────────────

test('item 5: an IBAN and a card number warn, masked; Go back keeps the mail, Send anyway sends it', async ({ browser }) => {
  const subject = `Send IBAN ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, `Please pay to ${IBAN}, card ${CARD}.`);
  await pressSend(alice);
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('Check before sending', { timeout: 20_000 });
  await expect(dialog).toContainText('IBAN DE89');
  await expect(dialog).toContainText('Card number ending 4242');
  await expect(dialog).not.toContainText('0532 0130');
  await expect(dialog).not.toContainText(CARD);
  await shot(alice, 'e-send-warn');
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  await expectNotSent(ENT.bob, subject);

  await pressSend(alice);
  await expect(dialog).toContainText('Check before sending', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Send anyway' }).click();
  await waitForMessage(ENT.bob, subject);
  await alice.context().close();
});

test('item 5: a block rule stops the send', async ({ browser }) => {
  const subject = `Send block ${RUN}`;
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], subject, `This is TOPSECRET-${RUN} material.`);
  await pressSend(alice);
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText("This message can't be sent", { timeout: 20_000 });
  await expect(dialog).toContainText(`TOPSECRET-${RUN}`);
  await expect(dialog.getByRole('button', { name: 'Send anyway' })).toHaveCount(0);
  await shot(alice, 'e-send-block');
  await alice.keyboard.press('Escape');
  await expect(alice.locator('[data-testid="email-composer"]')).toBeVisible();
  await expectNotSent(ENT.bob, subject);
  await alice.context().close();
});

test('item 5: an external-only rule ignores internal recipients, with the domain from a group scope for its members only', async ({ browser }) => {
  await setConfig(browser, SEND, { ibanExternalOnly: true });
  // partner.example.net is internal for ent-team (ent-alice) only.
  await setPolicy(browser, {
    scopes: [{ id: 'ent-e-partner', label: 'Partner', match: { groups: [ENT.team] }, policy: { organisation: { externalMail: { domains: ['partner.example.net'] } } } }],
  });
  try {
    const internal = `Send internal ${RUN}`;
    const alice = await userPage(browser, ENT.alice);
    await pluginsReady(alice);
    await compose(alice, [ENT.bob, 'someone@partner.example.net'], internal, `IBAN ${IBAN}`);
    await pressSend(alice);
    await waitForMessage(ENT.bob, internal);
    await expect(sendDialog(alice)).toHaveCount(0);
    await alice.context().close();

    // ent-carol is in no group: partner.example.net is outside for her.
    const outside = `Send outside ${RUN}`;
    const carol = await userPage(browser, ENT.carol);
    await pluginsReady(carol);
    await compose(carol, [ENT.bob, 'someone@partner.example.net'], outside, `IBAN ${IBAN}`);
    await pressSend(carol);
    const dialog = sendDialog(carol);
    await expect(dialog).toContainText('IBAN DE89', { timeout: 20_000 });
    await expect(dialog).toContainText('goes outside your organisation');
    await dialog.getByRole('button', { name: 'Go back' }).click();
    await expectNotSent(ENT.bob, outside);
    await carol.context().close();
  } finally {
    await setConfig(browser, SEND, { ibanExternalOnly: false });
    await setPolicy(browser, { scopes: (original.scopes as unknown[] | undefined) ?? [] });
  }
});

test('item 5: a program is refused as an attachment, also renamed to .pdf', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await compose(alice, [ENT.bob], `Send attachment ${RUN}`, 'See the file.');
  const program = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
  const input = alice.locator('[data-testid="email-composer"] input[type="file"]').first();
  await input.setInputFiles({ name: 'tool.exe', mimeType: 'application/octet-stream', buffer: program });
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText("This file can't be attached", { timeout: 20_000 });
  await expect(dialog).toContainText('tool.exe');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await input.setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: program });
  await expect(dialog).toContainText('invoice.pdf', { timeout: 20_000 });
  await shot(alice, 'e-send-attachment');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect(alice.locator('[data-testid="email-composer"]').getByText('invoice.pdf')).toHaveCount(0);
  await expect(alice.locator('[data-testid="email-composer"]').getByText('tool.exe')).toHaveCount(0);
  await alice.context().close();
});

test('item 5: a quick reply is checked too', async ({ browser }) => {
  const subject = `Quick ${RUN}`;
  await deliver({ from: ENT.bob, to: [ENT.alice], subject, text: 'Where do I pay?' });
  await waitForMessage(ENT.alice, subject);
  const alice = await userPage(browser, ENT.alice);
  await pluginsReady(alice);
  await openMessage(alice, subject);
  const box = alice.getByPlaceholder('Write a quick reply...');
  await box.fill(`To ${IBAN} please`);
  await box.press('Control+Enter');
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('IBAN DE89', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Go back' }).click();
  // The typed text stays, nothing went out.
  await expect(box).toHaveValue(`To ${IBAN} please`);
  await expectNotSent(ENT.bob, `Re: ${subject}`);
  await alice.context().close();
});

test('item 5: the send dialog fits at 390 px', async ({ browser }) => {
  const alice = await userPage(browser, ENT.alice, true);
  await pluginsReady(alice);
  await alice.getByRole('button', { name: /^(Compose|New message|Write)/ }).first().click().catch(() => alice.keyboard.press('c'));
  const composer = alice.locator('[data-testid="email-composer"]');
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  const input = alice.locator('[data-testid="composer-to"] input').first();
  await input.fill(ENT.bob);
  await input.press('Enter');
  await alice.locator('[data-testid="composer-subject"]').first().fill(`Send phone ${RUN}`);
  await composer.locator('[contenteditable="true"]').first().click();
  await alice.keyboard.type(`Card ${CARD}`);
  await alice.getByTestId('composer-send').first().click();
  const dialog = sendDialog(alice);
  await expect(dialog).toContainText('Card number ending 4242', { timeout: 20_000 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await shot(alice, 'e-send-phone');
  await dialog.getByRole('button', { name: 'Go back' }).click();
  await alice.context().close();
});

test('item 5: the admin sets the rules on the plugin page', async ({ browser }) => {
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto(`/admin/plugins/${SEND}`);
  await expect(page.getByText('IBANs', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Payment card numbers', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Blocked file types', { exact: true }).first()).toBeVisible();
  await shot(page, 'e-send-admin');
  await admin.close();
});
