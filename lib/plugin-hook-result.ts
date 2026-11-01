// "Before" hooks whose handlers may either stop an action (return false) or
// change what it does (return a value), such as onBeforeExternalLink
// (`{ href }`) and onBeforeCompose (a ComposeOptions to prefill). A payload
// changed in place has no effect: plugin handlers run in a sandboxed iframe
// and receive a copy.

import { uiHooks, type HookBus } from './plugin-hooks';
import type { ExternalLinkContext } from './plugin-types';
import { isOpenableLinkHref } from './email-sanitization';

export type InterceptResult<V> = { allowed: false } | { allowed: true; value: V };

/**
 * Ask every handler of an intercept bus once, in order. `false` stops the
 * action; any other return value goes through `accept`. See
 * HookBus.interceptWithValue.
 */
export async function interceptWithResult<V>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bus: HookBus<any>,
  value: V,
  accept: (result: unknown, current: V) => V | undefined,
): Promise<InterceptResult<V>> {
  if (!(bus && bus.size > 0)) return { allowed: true, value };
  return bus.interceptWithValue(value, accept);
}

/**
 * `accept` for onBeforeExternalLink: a handler may return `{ href }` to send
 * the click elsewhere. Only a web address is taken, so a plugin can't turn a
 * link into javascript:, data: or a path inside the app.
 */
export function acceptLinkRewrite<T extends { href: string }>(result: unknown, current: T): T | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const href = (result as { href?: unknown }).href;
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (!/^https?:/i.test(trimmed)) return undefined;
  try {
    new URL(trimmed);
  } catch {
    return undefined;
  }
  return { ...current, href: trimmed };
}

/**
 * Ask onBeforeExternalLink about a link the user opens. Resolves to the
 * address to open: the original, the one a plugin rewrote it to, or null
 * when a plugin stopped it. `skipPluginId`: a plugin opening a link itself
 * (ui.openExternalUrl) isn't asked about it again, so a link check can open
 * the link after its own dialog.
 */
export async function resolveExternalLink(ctx: ExternalLinkContext, opts: { skipPluginId?: string } = {}): Promise<string | null> {
  const outcome = uiHooks.onBeforeExternalLink.size > 0
    ? await uiHooks.onBeforeExternalLink.interceptWithValue(ctx, acceptLinkRewrite, { skipPluginId: opts.skipPluginId })
    : { allowed: true as const, value: ctx };
  if (!outcome.allowed || !isOpenableLinkHref(outcome.value.href)) return null;
  return outcome.value.href;
}

/** Longest link text handed to plugins. */
const MAX_LINK_TEXT = 200;

/** What a link says, for ExternalLinkContext.text: its text, else an image's alt text. */
export function linkText(link: Element): string | undefined {
  const own = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
  const text = own || (link.querySelector('img[alt]')?.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_LINK_TEXT) : undefined;
}

/**
 * Open an outside link the way every link in the app opens: through
 * onBeforeExternalLink, then in a new tab. Resolves true when it opened.
 */
export async function openExternalLink(ctx: ExternalLinkContext, opts: { skipPluginId?: string } = {}): Promise<boolean> {
  if (!isOpenableLinkHref(ctx.href)) return false;
  const target = await resolveExternalLink(ctx, opts);
  if (!target) return false;
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * A click or middle-click on a web link inside `event.currentTarget`
 * (rendered text with links, an anchor of our own): the browser's own
 * navigation is stopped and the link goes through openExternalLink. Other
 * links (mailto:, tel:, in-app paths) and other buttons are left alone.
 * "Copy link address" and the browser's context menu stay out of reach.
 */
export function gateLinkClick(event: { target: EventTarget | null; button: number; type: string; preventDefault(): void; stopPropagation(): void }, extra: Partial<ExternalLinkContext> = {}): void {
  if (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0) return;
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  if (!/^https?:/i.test(href.trim())) return;
  event.preventDefault();
  event.stopPropagation();
  void openExternalLink({ href: href.trim(), target: link.getAttribute('target') ?? '_blank', text: linkText(link), ...extra });
}
