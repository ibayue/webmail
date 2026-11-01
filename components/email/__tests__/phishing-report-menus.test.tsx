import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { usePolicyStore } from '@/stores/policy-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';

// Where "Report phishing" shows: the row menu, the reader's ⋮ and a
// selection's menu, only while the admin set an address and not in your own
// folders. A reported message ($phishing) shows a banner and its links are off.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { EmailContextMenu } = await import('../email-context-menu');

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Phish', email: 'bad@phish.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Parcel', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Track it <a href="https://phish.example/login">here</a></p>' } },
} as unknown as Email;
const other = { ...email, id: 'e2', blobId: 'b2', subject: 'Invoice' } as Email;
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

function setAddress(address: string) {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, phishingReport: { address, format: 'forward' } } },
  });
}

function rowMenu(role: string, props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  return render(
    <EmailContextMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole={role}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  usePhishingReportStore.setState({ pending: null, busy: false, opener: null });
});

describe('the row menu', () => {
  it('has no Report phishing while the admin set no address', () => {
    rowMenu('inbox');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
  });

  it('offers it once an address is set, and asks with that address', () => {
    setAddress('soc@example.org');
    rowMenu('inbox');
    fireEvent.click(screen.getByTestId('ctx-report-phishing'));
    expect(usePhishingReportStore.getState().pending).toEqual({ emails: [email], address: 'soc@example.org' });
  });

  it('shows up when the policy arrives after the menu opened', () => {
    rowMenu('inbox');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
    act(() => setAddress('soc@example.org'));
    expect(screen.getByTestId('ctx-report-phishing')).toBeTruthy();
  });

  it('is not offered in Sent', () => {
    setAddress('soc@example.org');
    rowMenu('sent');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
  });

  it('reports a whole selection, one message each', () => {
    setAddress('soc@example.org');
    rowMenu('inbox', { isMultiSelect: true, selectedCount: 2, batchEmails: [email, other], onBatchMarkAsSpam: vi.fn() });
    fireEvent.click(screen.getByTestId('ctx-batch-report-phishing'));
    expect(usePhishingReportStore.getState().pending?.emails.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('the reader', () => {
  it("offers it in the ⋮ menu", () => {
    setAddress('soc@example.org');
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    expect(within(screen.getByRole('menu', { name: 'more_actions' })).getByTestId('ctx-report-phishing')).toBeTruthy();
  });

  it('shows a reported message with a banner and its links turned off', async () => {
    const reported = { ...email, keywords: { $seen: true, $junk: true, $phishing: true } } as Email;
    const { container } = render(<EmailViewer email={reported} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="junk" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('phishing-mark-banner').textContent).toContain('banner');
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Track it');
    expect(srcdoc).not.toContain('https://phish.example/login');
    expect(srcdoc).toContain('data-link-off');
  });

  it('leaves the links of other messages alone', async () => {
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('phishing-mark-banner')).toBeNull();
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toContain('https://phish.example/login');
  });
});
