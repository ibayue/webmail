import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { usePolicyStore } from '@/stores/policy-store';
import { resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import type { OutgoingEmail } from '@/lib/plugin-types';

// ─── Heavy component mocks (mirrors composer-reply-signature.test.tsx) ─

// A stand-in for the TipTap editor: it hands the composer an editor object
// whose content is whatever the composer last rendered into it, the way the
// real editor reports itself ready from an effect after mounting.
const editorState = vi.hoisted(() => ({ html: '' }));
// A plugin that rewrites signatures (onSignatureRender), off unless a test turns it on.
const signaturePlugin = vi.hoisted(() => ({ on: false }));
// Send plugins: a footer added by onTransformOutgoingEmail, and a crypto
// plugin taking the send over (onComposeSend).
// What a send check plugin (onBeforeEmailSend) was handed.
const sendChecks = vi.hoisted(() => ({ seen: [] as unknown[] }));
const sendPlugins = vi.hoisted(() => ({
  footer: false,
  takeOver: null as null | ((request: { htmlBody: string; textBody: string }) => void),
}));
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ content, onChange, onEditorReady }: {
    content: string;
    onChange: (html: string) => void;
    onEditorReady?: (editor: unknown) => void;
  }) => {
    editorState.html = content;
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;
    React.useEffect(() => {
      onEditorReady?.({
        isDestroyed: false,
        commands: {
          focus: () => {},
          setContent: (html: string) => {
            editorState.html = html;
            onChangeRef.current(html);
          },
        },
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement('div', { 'data-testid': 'rich-text-editor', 'data-html': content });
  },
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [
      { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' },
      { id: 'id-team', email: 'team@example.com', name: 'Team', htmlSignature: '', textSignature: '' },
    ] as Array<Record<string, unknown>>,
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook, notifyIdentitySelected: () => {} };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: false,
    signatureDetails: { title: '', department: '', phone: '', mobile: '' },
    sendDelaySeconds: 0,
    // The default position: replies/forwards get the signature appended at
    // send time rather than embedded above the quote.
    signaturePosition: 'below_quote',
    signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    externalContentPolicy: 'block',
    isSenderTrusted: () => false,
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  identityHooks: {
    onSignatureRender: {
      get size() { return signaturePlugin.on ? 1 : 0; },
      transform: async (value: { html: string; text: string }) => ({ html: `${value.html}<p>PLUGIN</p>`, text: `${value.text} PLUGIN` }),
    },
    onIdentitySelect: { size: 0, emit: async () => {} },
  },
  templateHooks: {
    onTemplateRender: { size: 0, transform: async (value: unknown) => value },
    onTemplateApply: { size: 0, emit: async () => {} },
  },
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: {
      size: 1,
      intercept: async () => true,
      interceptOutcome: async (email: unknown) => { sendChecks.seen.push(email); return 'allowed'; },
    },
    onComposeSend: {
      takeOver: async (request: { htmlBody: string; textBody: string }) => {
        if (!sendPlugins.takeOver) return 'default';
        sendPlugins.takeOver(request);
        return 'handled';
      },
    },
    onTransformOutgoingEmail: {
      transform: async (email: { htmlBody: string; textBody: string }) => (sendPlugins.footer
        ? { ...email, htmlBody: `${email.htmlBody}<p>Plugin footer</p>`, textBody: `${email.textBody}\n\nPlugin footer` }
        : email),
    },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: (html: string) => `<div data-quoted-html="">${html}</div>`,
  serializeEditorContent: () => editorState.html,
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * A send check plugin gets what it needs to judge a message without the
 * quoted original and without the policy: the user's own text, the
 * recipients outside the organisation, where the send comes from.
 */

const DRAFT = {
  to: 'bob@example.com, Carol <carol@partner.test>',
  cc: '',
  bcc: 'mallory@evil.test',
  subject: 'Re: Invoice',
  body: '<p>Pay to DE89 3704 0044 0532 0130 00 please.</p><blockquote>Quoted: DE44 5001 0517 5407 3249 31</blockquote>',
  showCc: false,
  showBcc: true,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-1',
};

function setPolicy(domains: string[]) {
  const policy: SettingsPolicy = {
    ...DEFAULT_POLICY,
    organisation: {
      ...DEFAULT_ORGANISATION_POLICY,
      externalMail: { ...DEFAULT_ORGANISATION_POLICY.externalMail, recipientWarning: false, domains },
    },
  };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null });
}

describe('composer: what a send check plugin gets', () => {
  beforeEach(() => {
    resetSendPipeline();
    sendChecks.seen = [];
    setPolicy([]);
  });
  afterEach(() => {
    resetSendPipeline();
    vi.clearAllMocks();
  });

  it('the authored text without the quote, the external recipients and the surface', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" initialData={{ ...DRAFT, mode: 'reply' as const }} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(sendChecks.seen).toHaveLength(1);
    const email = sendChecks.seen[0] as OutgoingEmail;
    expect(email.surface).toBe('composer');
    expect(email.mode).toBe('reply');
    expect(email.authoredText).toContain('DE89 3704 0044 0532 0130 00');
    expect(email.authoredText).not.toContain('DE44');
    expect(email.htmlBody).toContain('DE44');
    // Internal: the identity's own domain. The admin's warning is off.
    expect(email.externalRecipients).toEqual(['carol@partner.test', 'mallory@evil.test']);
  });

  it("counts the admin's organisation domains as internal", async () => {
    setPolicy(['partner.test']);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((sendChecks.seen[0] as OutgoingEmail).externalRecipients).toEqual(['mallory@evil.test']);
  });
});
