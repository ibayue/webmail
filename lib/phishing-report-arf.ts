/**
 * The ARF format of a phishing report (RFC 5965, an admin option of
 * Organisation > Security > Phishing reports): a multipart/report with
 * report-type=feedback-report and three parts, a short text for people, the
 * machine-readable message/feedback-report (Feedback-Type: fraud, which
 * RFC 5965 §7.3 defines as "fraud or phishing"), and the original whole and
 * unchanged as message/rfc822.
 *
 * JMAP can't set the report-type parameter through Email/set, so this is
 * raw MIME: the original's bytes are downloaded, wrapped and uploaded, then
 * submitted with submitRawEmail (no Sent copy). The upload counts against
 * the server's upload quota and is limited by maxSizeUpload.
 */

import type { Email } from '@/lib/jmap/types';
import { base64Body, displayName, encodeHeaderWord, headerAtom, randomToken, rfc5322Date } from '@/lib/mdn';
import { reportSubject, type ArfInput } from './phishing-report';

export interface ArfParts {
  /** Everything before the original's bytes. */
  head: string;
  /** Everything after them. */
  tail: string;
}

function appVersion(): string {
  return (process.env.NEXT_PUBLIC_APP_VERSION || '').trim() || 'unknown';
}

/** "Reported-Domain": the domain of the original's From, when it has one. */
function senderDomain(email: Pick<Email, 'from'>): string | null {
  const address = email.from?.[0]?.email ?? '';
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return address.includes('@') && /^[A-Za-z0-9.-]+$/.test(domain) ? domain.toLowerCase() : null;
}

/**
 * The report around the original. `eightBit`: the original has bytes
 * outside 7-bit ASCII (message/rfc822 may not be base64-encoded, RFC 2046
 * §5.2.1, so its part says 8bit then).
 */
export function buildArfParts(input: {
  email: Pick<Email, 'subject' | 'receivedAt' | 'from' | 'messageId'>;
  reporter: { name?: string; email: string };
  to: string;
  eightBit: boolean;
  now?: Date;
}): ArfParts {
  const { email, reporter } = input;
  const fromEmail = headerAtom(reporter.email);
  const domain = fromEmail.split('@')[1] || 'localhost';
  const boundary = `----=_ARF_${randomToken()}`;
  const fromName = reporter.name?.trim() ? displayName(reporter.name.trim()) : '';
  const arrival = email.receivedAt ? new Date(email.receivedAt) : null;
  const reportedDomain = senderDomain(email);
  const human = [
    `This is a phishing report (RFC 5965) sent by ${fromEmail} with Bulwark.`,
    '',
    'The reported message is attached unchanged.',
  ].join('\r\n');
  const report = [
    'Feedback-Type: fraud',
    `User-Agent: Bulwark/${appVersion()}`,
    'Version: 1',
    ...(arrival && !Number.isNaN(arrival.getTime()) ? [`Arrival-Date: ${rfc5322Date(arrival)}`] : []),
    `Original-Rcpt-To: ${fromEmail}`,
    ...(reportedDomain ? [`Reported-Domain: ${reportedDomain}`] : []),
  ].join('\r\n');

  const head = [
    `Date: ${rfc5322Date(input.now ?? new Date())}`,
    `From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
    `To: ${headerAtom(input.to)}`,
    `Subject: ${encodeHeaderWord(reportSubject(email.subject))}`,
    `Message-ID: <arf.${randomToken()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=feedback-report;',
    `\tboundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(human),
    '',
    `--${boundary}`,
    'Content-Type: message/feedback-report',
    'Content-Transfer-Encoding: 7bit',
    '',
    report,
    '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="reported-message.eml"',
    `Content-Transfer-Encoding: ${input.eightBit ? '8bit' : '7bit'}`,
    '',
    '',
  ].join('\r\n');
  const tail = `\r\n--${boundary}--\r\n`;
  return { head, tail };
}

function hasEightBit(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return true;
  return false;
}

/** The whole report as a Blob, the original downloaded from its own account. */
export async function buildArfReportBlob(input: ArfInput): Promise<Blob> {
  const { client, email, sourceAccountId } = input;
  if (!email.blobId) throw new Error('The message has no content to report');
  const original = new Uint8Array(await client.fetchBlobArrayBuffer(email.blobId, 'message.eml', 'message/rfc822', sourceAccountId));
  const parts = buildArfParts({ email, reporter: input.reporter, to: input.to, eightBit: hasEightBit(original) });
  // The original goes in byte for byte; the closing boundary needs a line break before it.
  const endsWithBreak = original.length >= 2 && original[original.length - 2] === 0x0d && original[original.length - 1] === 0x0a;
  return new Blob([parts.head, original, endsWithBreak ? parts.tail.slice(2) : parts.tail], { type: 'message/rfc822' });
}
