/**
 * Whether a plugin's raw send (api.jmap.sendRaw / submitRaw) completes a
 * send the composer handed it (onComposeSend: S/MIME, PGP). Such a send ran
 * every step at Send, with the user present, so offline mode may keep the
 * finished message in its outbox (#523). A plugin's own sends (a forward, a
 * report) aren't covered and need the server.
 */

let open = 0;

/** Called by the composer right before it hands the send to the plugins; pair with endComposeTakeover. */
export function beginComposeTakeover(): void {
  open += 1;
}

export function endComposeTakeover(): void {
  open = Math.max(0, open - 1);
}

export function composeTakeoverOpen(): boolean {
  return open > 0;
}
