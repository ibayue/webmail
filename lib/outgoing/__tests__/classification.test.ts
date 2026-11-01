import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import { usePolicyStore } from '@/stores/policy-store';
import { customHeaderProperties, withLabelHeaders } from '../custom-headers';
import {
  automaticLabel,
  beginLabelTakeover,
  classifyOutgoing,
  endLabelTakeover,
  injectTakeoverLabel,
  isLabelRequiredError,
  labelSourceHeaders,
  resetLabelTakeovers,
  reopenedLabelChoice,
  resolveLabel,
} from '../classification';

// The label stage of sending: which label goes out, the required label
// failing closed, plugin headers that can't override it, the policy of the
// sending account, and the headers a crypto takeover's raw send gets.

const generic = LABEL_PRESETS[0];
const policy = { list: generic.list, defaultId: 'internal', required: false, extraHeader: 'X-Classification' };
const required = { ...policy, defaultId: '', required: true };
const label = (id: string) => generic.list.find((l) => l.id === id)!;

const fromColleague = (marking: string) => ({ headers: { 'SIO-Label': ` marking="${marking}"` }, from: [{ email: 'colleague@example.org' }] });
const fromOutsider = (marking: string) => ({ headers: { 'SIO-Label': ` marking="${marking}"` }, from: [{ email: 'news@outside.example' }] });

beforeEach(() => {
  useAuthStore.setState({ identities: [{ id: 'id-me', name: 'Me', email: 'me@example.org' }] } as never);
});

afterEach(() => {
  usePolicyStore.setState({ policy: DEFAULT_POLICY, rawPolicy: DEFAULT_POLICY, subject: null });
  useAuthStore.setState({ identities: [] } as never);
  resetLabelTakeovers();
});

describe('the label of the original', () => {
  it('counts only when an internal sender set it: an outsider can write any header', () => {
    expect(resolveLabel(policy, undefined, fromOutsider('PUBLIC'))?.id).toBe('internal');
    expect(resolveLabel(policy, undefined, fromOutsider('CONFIDENTIAL'))?.id).toBe('internal');
    expect(resolveLabel(policy, undefined, { headers: { 'SIO-Label': ' marking="CONFIDENTIAL"' } })?.id).toBe('internal');
  });

  it('never goes below the default', () => {
    expect(resolveLabel(policy, undefined, fromColleague('PUBLIC'))?.id).toBe('internal');
    expect(resolveLabel(policy, undefined, fromColleague('STRICTLY CONFIDENTIAL'))?.id).toBe('strictly-confidential');
    // Without a default, an internal label counts whatever it is.
    expect(resolveLabel({ ...policy, defaultId: '' }, undefined, fromColleague('PUBLIC'))?.id).toBe('public');
  });
});

describe('a message opened again', () => {
  it('keeps the label a sent copy went out with (Undo, Cancel and edit), a draft’s own pick first', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: policy } } });
    expect(reopenedLabelChoice({ 'SIO-Label': 'marking="CONFIDENTIAL"; bgcolor=#d97706' })).toBe('confidential');
    expect(reopenedLabelChoice({ 'X-Bulwark-Label': 'none', 'SIO-Label': 'marking="CONFIDENTIAL"' })).toBeNull();
    expect(reopenedLabelChoice({ 'X-Bulwark-Label': 'public' })).toBe('public');
    expect(reopenedLabelChoice({})).toBeUndefined();
  });
});

describe('resolveLabel', () => {
  it('takes the pick, then the original’s label, then the default', () => {
    expect(resolveLabel(policy, 'public')?.id).toBe('public');
    expect(resolveLabel(policy, undefined, fromColleague('CONFIDENTIAL'))?.id).toBe('confidential');
    expect(resolveLabel(policy, undefined)?.id).toBe('internal');
    expect(resolveLabel(policy, null, fromColleague('CONFIDENTIAL'))).toBeNull();
    // A pick that isn't in this account's list counts as nothing picked.
    expect(resolveLabel(policy, 'gone')?.id).toBe('internal');
  });
});

describe('classifyOutgoing', () => {
  it('fails closed when a label is required and there is none', () => {
    let error: unknown;
    try { classifyOutgoing(required, null, { subject: 'x' }); } catch (e) { error = e; }
    expect(isLabelRequiredError(error)).toBe(true);
  });

  it('prefixes the subject and adds the headers', () => {
    const out = classifyOutgoing(policy, label('confidential'), { subject: 'Re: Budget' });
    expect(out.subject).toBe('[Confidential] Re: Budget');
    expect(out.labelHeaders).toMatchObject({ 'header:Sensitivity:asText': 'Company-Confidential', 'header:X-Classification:asText': 'Confidential' });
  });

  it('keeps a plugin from setting or dropping the label', () => {
    const out = classifyOutgoing(policy, label('internal'), {
      subject: 'Budget',
      headers: { 'SIO-Label': 'marking="PUBLIC"', Sensitivity: 'Personal', 'x-classification': 'Public', 'X-Mailer-Note': 'ok' },
    });
    expect(out.headers).toEqual({ 'X-Mailer-Note': 'ok' });
    const props = withLabelHeaders(customHeaderProperties({ ...out.headers, 'SIO-Label': 'forged' }), out.labelHeaders);
    expect(props['header:SIO-Label:asRaw']).toContain('INTERNAL');
    expect(Object.keys(props).filter((k) => k.toLowerCase().startsWith('header:sio-label'))).toHaveLength(1);
    expect(props['header:X-Mailer-Note:asText']).toBe('ok');
  });

  it('changes nothing while the organisation has no labels', () => {
    const headers = { Sensitivity: 'Personal' };
    expect(classifyOutgoing({ ...policy, list: [] }, null, { subject: 'x', headers })).toEqual({ subject: 'x', headers });
  });
});

describe('the policy of the sending account', () => {
  it('quick reply and forward take the original’s label, and report a missing required one', () => {
    usePolicyStore.setState({
      policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: required } },
      subject: { email: 'me@example.org', groups: [] },
    });
    expect(automaticLabel({ email: 'me@example.org' }, fromColleague('PUBLIC'))).toMatchObject({ missing: false, label: { id: 'public' } });
    expect(automaticLabel({ email: 'me@example.org' }, { headers: {} })).toMatchObject({ missing: true, label: null });
    // An outsider's label doesn't count: a required label is still missing.
    expect(automaticLabel({ email: 'me@example.org' }, fromOutsider('PUBLIC'))).toMatchObject({ missing: true, label: null });
  });

  it('keeps only the headers a reply needs for its label', () => {
    usePolicyStore.setState({ rawPolicy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: policy } } });
    expect(labelSourceHeaders({ 'SIO-Label': 'x', 'X-Classification': 'y', Received: 'z', Subject: 's' })).toEqual({ 'SIO-Label': 'x', 'X-Classification': 'y' });
    expect(labelSourceHeaders({ Received: 'z' })).toBeUndefined();
  });
});

describe('crypto takeovers', () => {
  const raw = (head: string) => new TextEncoder().encode(`${head}\r\n\r\nContent-Type: application/pkcs7-mime\r\n\r\nSIGNED-BYTES\r\n`);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it('add the label headers to the top-level header block, outside the signed part', () => {
    const token = beginLabelTakeover(policy, label('confidential'), 'id-1', '[Confidential] Budget');
    const out = decode(injectTakeoverLabel(raw('From: a@example.org\r\nSubject: [Confidential] Budget'), 'id-1'));
    const [head, ...rest] = out.split('\r\n\r\n');
    expect(head).toContain('SIO-Label: marking="CONFIDENTIAL"');
    expect(head).toContain('Sensitivity: Company-Confidential');
    expect(head).toContain('X-Classification: Confidential');
    expect(rest.join('\r\n\r\n')).toBe('Content-Type: application/pkcs7-mime\r\n\r\nSIGNED-BYTES\r\n');
    endLabelTakeover(token);
  });

  it('replace label headers the plugin wrote, and leave 8-bit header bytes alone', () => {
    beginLabelTakeover(policy, label('public'), 'id-1', 'Grüße');
    const input = raw('Subject: Grüße\r\nSIO-Label: marking="FORGED";\r\n bgcolor=red\r\nX-Classification: Secret');
    const out = decode(injectTakeoverLabel(input, 'id-1'));
    expect(out).not.toContain('FORGED');
    expect(out).not.toContain('bgcolor=red');
    expect(out).not.toContain('Secret');
    expect(out).toContain('Subject: Grüße');
    expect(out.match(/SIO-Label:/g)).toHaveLength(1);
  });

  it('touch nothing outside a takeover, or for another identity', () => {
    const input = raw('Subject: x');
    expect(injectTakeoverLabel(input, 'id-1')).toBe(input);
    const token = beginLabelTakeover(policy, label('public'), 'id-1', 'x');
    expect(injectTakeoverLabel(input, 'id-2')).toBe(input);
    endLabelTakeover(token);
    expect(injectTakeoverLabel(input, 'id-1')).toBe(input);
  });

  it('pick the right takeover by subject when two run at once', () => {
    beginLabelTakeover(policy, label('public'), 'id-1', 'First');
    beginLabelTakeover(policy, label('confidential'), 'id-1', '[Confidential] Second');
    const out = decode(injectTakeoverLabel(raw('Subject: [Confidential] Second'), 'id-1'));
    expect(out).toContain('marking="CONFIDENTIAL"');
  });
});
