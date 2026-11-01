/**
 * Plugins' say before a user's mail goes out (onBeforeEmailSend), the same
 * for every surface that sends it: the composer (inline, pop-out, Pro tab),
 * quick reply and a plugin's forward (api.email.forward). The bus fails
 * closed: a handler that throws or runs out of time stops the send.
 *
 * Not run for mail Bulwark sends on its own (calendar invitations and RSVP
 * replies, read receipts, List-Unsubscribe mails, phishing reports) nor for
 * a crypto plugin's raw send, which happens after the composer's check.
 */

import { emailHooks } from '@/lib/plugin-hooks';
import type { OutgoingEmail } from '@/lib/plugin-types';

/**
 * allowed: send. vetoed: a plugin said no and told the user. failed: a
 * handler threw or ran out of time (nobody told the user yet).
 */
export type PluginSendCheckOutcome = 'allowed' | 'vetoed' | 'failed';

export async function runPluginSendCheck(email: OutgoingEmail): Promise<PluginSendCheckOutcome> {
  return emailHooks.onBeforeEmailSend.interceptOutcome(email);
}
