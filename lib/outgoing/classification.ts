/**
 * The classification label stage of sending (enterprise pack item 3).
 * Every surface that sends a user's mail runs it last, after plugins'
 * onTransformOutgoingEmail, so a plugin can't drop or change the label:
 *
 * - the composer (inline, pop-out and Pro tab), with the user's pick;
 * - quick reply, with the original's label, else the default;
 * - a plugin's forward (api.email.forward), the same way.
 *
 * A required label fails closed: with none, the stage throws
 * LabelRequiredError and nothing is sent. Labels come from the policy of
 * the account and identity the mail goes out from, never just the active
 * account. Automatic mail carries none: calendar invitations and RSVP
 * replies, read receipts, List-Unsubscribe mails and phishing reports.
 *
 * S/MIME and PGP plugins take over the send (onComposeSend) and build raw
 * MIME themselves: the composer hands them the prefixed subject, and the
 * host adds the label headers to the top-level header block of the raw
 * message in api.jmap.sendRaw / submitRaw while that takeover runs, keyed
 * to its token (beginLabelTakeover), outside the signed or encrypted part.
 */

import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { subjectForAccount } from '@/lib/org/account-subjects';
import { policyForSender } from '@/lib/org/signature-state';
import { usePolicyStore } from '@/stores/policy-store';
import { generateUUID } from '@/lib/utils';
import { withoutLabelHeaders } from './custom-headers';
import {
  applyLabelPrefix,
  labelHeaderLines,
  labelHeaderProperties,
  receivedLabel,
  type LabelsPolicy,
} from '@/lib/classification/labels';

/** A send stopped because the organisation requires a label and none was picked. */
export class LabelRequiredError extends Error {
  constructor() {
    super('A classification label is required');
    this.name = 'LabelRequiredError';
  }
}

export function isLabelRequiredError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'LabelRequiredError';
}

export interface LabelSender {
  /** The From identity's address (a group's own picks the group's scopes). */
  email?: string;
  /** The signed-in account (AccountEntry id) it goes out through; the active one when left out. */
  accountId?: string | null;
}

/** The labels section that applies to mail from `sender`, read from the stores now. */
export function labelsPolicyFor(sender: LabelSender): LabelsPolicy {
  const policy = policyForSender(usePolicyStore.getState(), sender.email, subjectForAccount(sender.accountId));
  return policy.organisation?.labels ?? DEFAULT_ORGANISATION_POLICY.labels;
}

/**
 * The label a message goes out with. `choice`: the user's pick (an id),
 * null for "no label", undefined when they picked nothing, which takes the
 * original's label (a reply or forward of `originalHeaders`), else the
 * default. A pick that isn't in the list (another account's, an old one)
 * counts as nothing picked.
 */
export function resolveLabel(
  policy: LabelsPolicy,
  choice: string | null | undefined,
  originalHeaders?: Record<string, string | string[]> | null,
): ClassificationLabel | null {
  if (policy.list.length === 0) return null;
  if (choice === null) return null;
  const picked = choice ? policy.list.find((label) => label.id === choice) : undefined;
  if (picked) return picked;
  const original = originalHeaders ? receivedLabel(originalHeaders, policy) : null;
  if (original) return original;
  return policy.list.find((label) => label.id === policy.defaultId) ?? null;
}

/** Whether sending needs a label that `label` doesn't give. */
export function labelMissing(policy: LabelsPolicy, label: ClassificationLabel | null): boolean {
  return policy.required && policy.list.length > 0 && !label;
}

export interface LabelledMessage {
  subject: string;
  /** The plugins' headers, without any the label writes. */
  headers?: Record<string, string>;
  /** The label's headers as JMAP create properties (SubmissionSendOptions.labelHeaders). */
  labelHeaders?: Record<string, string>;
}

/**
 * The stage: the subject with the label's prefix (once), the plugins'
 * headers without the label's names, and the label's headers. Throws
 * LabelRequiredError when the policy requires a label and there is none.
 */
export function classifyOutgoing(
  policy: LabelsPolicy,
  label: ClassificationLabel | null,
  message: { subject: string; headers?: Record<string, string> },
): LabelledMessage {
  if (policy.list.length === 0) return { subject: message.subject, headers: message.headers };
  if (labelMissing(policy, label)) throw new LabelRequiredError();
  const reserved = policy.extraHeader ? [policy.extraHeader] : [];
  return {
    subject: applyLabelPrefix(message.subject, label, policy.list),
    headers: withoutLabelHeaders(message.headers, reserved),
    labelHeaders: label ? labelHeaderProperties(label, policy.extraHeader) : undefined,
  };
}

/** The label of a quick reply or a plugin's forward: the original's, else the default. */
export function automaticLabel(
  sender: LabelSender,
  originalHeaders?: Record<string, string | string[]> | null,
): { policy: LabelsPolicy; label: ClassificationLabel | null; missing: boolean } {
  const policy = labelsPolicyFor(sender);
  const label = resolveLabel(policy, undefined, originalHeaders);
  return { policy, label, missing: labelMissing(policy, label) };
}

// ─── Crypto takeovers ─────────────────────────────────────────

interface Takeover {
  identityId: string;
  subject: string;
  lines: string[];
}

const takeovers = new Map<string, Takeover>();

/**
 * Registers the label of a takeover about to run (onComposeSend). Raw
 * sends during it from the same identity get the label's header lines.
 * Returns the token; pass it to endLabelTakeover when the takeover ended.
 */
export function beginLabelTakeover(
  policy: LabelsPolicy,
  label: ClassificationLabel | null,
  identityId: string,
  subject: string,
): string | null {
  if (!label) return null;
  const token = generateUUID();
  takeovers.set(token, { identityId, subject, lines: labelHeaderLines(label, policy.extraHeader) });
  return token;
}

export function endLabelTakeover(token: string | null): void {
  if (token) takeovers.delete(token);
}

const LABEL_LINE_NAMES = ['sio-label', 'sio-label-history', 'sensitivity', 'x-bulwark-label'];

/** The Subject header of a raw message's top-level block, unfolded and decoded enough to compare. */
function rawSubject(head: string): string {
  const m = /(?:^|\r?\n)Subject:([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/i.exec(head);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/**
 * The takeover a raw send belongs to: the one running for `identityId`;
 * when several are (two composers sending at once), the one whose subject
 * is the message's.
 */
function takeoverFor(identityId: string, head: string): Takeover | null {
  const candidates = [...takeovers.values()].filter((t) => t.identityId === identityId);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const subject = rawSubject(head);
  return candidates.find((t) => t.subject === subject) ?? candidates[0];
}

/**
 * `bytes` (a raw RFC 5322 message) with the label's headers added to its
 * top-level header block, when a labelled takeover is running for
 * `identityId`; the same bytes otherwise. Label headers the plugin wrote
 * itself are replaced.
 */
export function injectTakeoverLabel(bytes: Uint8Array, identityId: string): Uint8Array {
  if (takeovers.size === 0) return bytes;
  // The header block is ASCII (RFC 5322 §2.2); find its end without decoding the body.
  let end = -1;
  let breakLength = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) { end = i; breakLength = 4; break; }
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) { end = i; breakLength = 2; break; }
  }
  if (end < 0) return bytes;
  // Byte for byte, so 8-bit header bytes (a raw UTF-8 subject) come back unchanged.
  let head = '';
  for (let i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
  const takeover = takeoverFor(identityId, head);
  if (!takeover) return bytes;
  const eol = breakLength === 4 ? '\r\n' : '\n';
  // Drop the label headers already there (with their folded lines).
  const kept: string[] = [];
  let skipping = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    skipping = LABEL_LINE_NAMES.includes(name) || takeover.lines.some((l) => l.slice(0, l.indexOf(':')).toLowerCase() === name);
    if (!skipping) kept.push(line);
  }
  const added = takeover.lines.map((line) => line.replace(/\r\n/g, eol));
  const text = [...kept, ...added].join(eol);
  const newHead = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  const out = new Uint8Array(newHead.length + (bytes.length - end));
  out.set(newHead, 0);
  out.set(bytes.subarray(end), newHead.length);
  return out;
}

/** For tests. */
export function resetLabelTakeovers(): void {
  takeovers.clear();
}

/**
 * The original's headers a reply or forward needs for its label: SIO-Label
 * and every extra header name any scope of the policy uses. Small enough
 * to keep in a Pro tab's saved state.
 */
export function labelSourceHeaders(headers: Record<string, string | string[]> | null | undefined): Record<string, string | string[]> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const raw = usePolicyStore.getState().rawPolicy;
  const names = new Set(['sio-label']);
  const add = (name: string | undefined) => { if (name) names.add(name.toLowerCase()); };
  add(raw.organisation?.labels?.extraHeader);
  for (const scope of raw.scopes ?? []) add(scope.policy.organisation?.labels?.extraHeader);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (names.has(name.toLowerCase())) out[name] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}
