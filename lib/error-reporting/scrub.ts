/**
 * What an error report may carry, applied in the browser before sending and
 * again on the server for everything a browser posts (lib/error-reporting).
 *
 * Mail content must never leave the browser in an error, not even to the
 * admin's own error tracker: no message bodies, subjects, addresses, file
 * names, tokens, cookies or URLs. Error messages are free text, so the rules
 * remove whatever could be such content: quoted text, addresses, URLs, file
 * names, credentials, long random-looking strings, key=value pairs, and
 * everything after the first line. What stays is the shape of the message
 * ("Cannot read properties of undefined (reading "…")").
 *
 * Documented at https://bulwarkmail.org/docs/admin/monitoring#what-is-removed
 */

export const MAX_MESSAGE_LENGTH = 200;

const REDACTED = '…';

// Quoted text: "…", '…', `…`, “…”, „…“, ‘…’, «…», ‹…›. A single quote only
// counts when it starts after a space or bracket, so "can't" stays a word.
const QUOTED: RegExp[] = [
  /"[^"\n]*"/g,
  /`[^`\n]*`/g,
  /[“„][^”“\n]*[”“]/g,
  /‘[^’\n]*’/g,
  /«[^»\n]*»/g,
  /‹[^›\n]*›/g,
  /(^|[\s([{:,=])'[^'\n]*'(?=$|[\s)\]}.,:;!?])/g,
];

const EMAIL = /[^\s@<>"'`()[\]{},;:]+@[^\s@<>"'`()[\]{},;:]+\.[^\s@<>"'`()[\]{},;:]+/g;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]*/gi;
const WWW = /\bwww\.[^\s"'`<>()]+/gi;
const AUTH = /\b(Bearer|Basic|Token)\s+[^\s,;]+/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const KEY_VALUE = /\b([A-Za-z_][\w.-]{0,40})=([^\s&;,]+)/g;
const FILE_NAME = /[^\s/\\"'`<>()]+\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|eml|msg|ics|vcf|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|heic|svg|mp[34]|mov|wav|html?|xml|json|p7[msc]|asc|gpg|pgp|key|pem)\b/gi;
// Runs of letters and digits that look random: ids, hashes, keys, tokens.
const LONG_RUN = /[A-Za-z0-9+/_=-]{24,}/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const PHONE = /\+?\d[\d ()-]{7,}\d/g;

function looksRandom(run: string): boolean {
  // Long identifiers in code are words glued together: keep them when they
  // are only letters. Anything with digits or symbols mixed in goes.
  return /\d/.test(run) || /[+/=_-]/.test(run) || run.length > 40;
}

/** Free text from an error, made safe to send. */
export function scrubText(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '';
  // Only the first line: server answers, stack traces and multi-line content
  // that ended up in a message all come after it.
  let text = input.split(/\r?\n/, 1)[0];
  // "Request failed: 400 - <server answer>": the answer may echo a subject.
  text = text.replace(/^(.*?\b\d{3})\s+-\s.*$/, '$1');
  text = text.replace(AUTH, '$1 [token]');
  text = text.replace(JWT, '[token]');
  text = text.replace(URL_LIKE, '[url]');
  text = text.replace(WWW, '[url]');
  text = text.replace(EMAIL, '[email]');
  for (const quoted of QUOTED) {
    text = text.replace(quoted, (match, lead?: string) => {
      const prefix = typeof lead === 'string' ? lead : '';
      const quote = match.slice(prefix.length, prefix.length + 1);
      const close = match.slice(-1);
      return `${prefix}${quote}${REDACTED}${close}`;
    });
  }
  text = text.replace(FILE_NAME, '[file]');
  text = text.replace(KEY_VALUE, '$1=[redacted]');
  text = text.replace(LONG_RUN, (run) => (looksRandom(run) ? '[id]' : run));
  text = text.replace(IPV4, '[ip]');
  text = text.replace(PHONE, '[number]');
  if (text.length > MAX_MESSAGE_LENGTH) text = `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  return text;
}

/** An error name: a code identifier, or "Error". */
export function scrubName(input: unknown): string {
  return typeof input === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(input) ? input : 'Error';
}

/** A function name from a stack frame: identifiers and the usual decorations only. */
export function scrubFunctionName(input: unknown): string | undefined {
  if (typeof input !== 'string' || input === '') return undefined;
  const trimmed = input.trim().slice(0, 120);
  return /^[\w$.<>[\] /#-]+$/.test(trimmed) && !/@/.test(trimmed) ? trimmed : '?';
}

/**
 * The path of a stack frame's file, without origin, base path, query or
 * fragment: `/_next/static/chunks/x.js` for the browser bundle,
 * `/.next/server/...` for the server's, `node:...` for Node's own modules,
 * `node_modules/...` for dependencies; `[other]` for anything else
 * (extensions, plugin code, evaluated code).
 */
export function scrubFramePath(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '[other]';
  const path = input.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  for (const marker of ['/_next/static/', '/.next/server/', '/.next/static/']) {
    const at = path.indexOf(marker);
    if (at >= 0) {
      const rest = path.slice(at);
      return /^[\w./()[\]@+~-]+$/.test(rest) ? rest.replace('/.next/static/', '/_next/static/') : '[other]';
    }
  }
  if (/^node:[\w/.-]+$/.test(path)) return path;
  const modules = path.lastIndexOf('/node_modules/');
  if (modules >= 0) {
    const rest = path.slice(modules + 1);
    return /^[\w./@+~-]+$/.test(rest) ? rest : '[other]';
  }
  return '[other]';
}

/** A JMAP method name ("Email/get") or a fixed placeholder. */
export function scrubMethodName(input: unknown): string {
  return typeof input === 'string' && /^[A-Z][A-Za-z]{0,40}\/[a-z][A-Za-z]{0,40}$/.test(input) ? input : 'Unknown/method';
}

/** A JMAP error type ("serverFail", "overQuota") or a fixed placeholder. */
export function scrubJmapErrorType(input: unknown): string {
  return typeof input === 'string' && /^[a-z][A-Za-z]{1,40}$/.test(input) ? input : 'unknown';
}
