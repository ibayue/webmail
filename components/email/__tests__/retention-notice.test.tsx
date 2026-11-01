import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderRetentionLine, RetentionNotice } from '../retention-notice';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useRecoveryStore } from '@/stores/recovery-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import type { Mailbox } from '@/lib/jmap/types';

// The retention line of Trash and Junk (Organisation > Notices): the
// admin's days, one line in each folder, sharing Trash's line with the
// Recover deleted items link when that shows.

vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ stalwartFeaturesEnabled: true, isLoading: false }) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));

const TRASH = { id: 't', name: 'Trash', role: 'trash', accountId: 'ci' } as Mailbox;
const JUNK = { id: 'j', name: 'Junk', role: 'junk', accountId: 'ci' } as Mailbox;
const INBOX = { id: 'i', name: 'Inbox', role: 'inbox', accountId: 'ci' } as Mailbox;

const initialPolicy = usePolicyStore.getState();
const initialAuth = useAuthStore.getState();

function setup(retention: { trashDays: number; junkDays: number }, recovery = false) {
  const policy = { ...initialPolicy.policy, restrictions: {}, organisation: { ...DEFAULT_ORGANISATION_POLICY, retention } };
  usePolicyStore.setState({ loaded: true, rawPolicy: policy, policy });
  const client = {
    getAccountId: () => 'ci',
    getUsername: () => 'a@example.org',
    advertisesArchivedItems: () => recovery,
    queryArchivedItemIds: vi.fn(async () => ({ ids: [], total: null })),
    hasArchivedEmail: vi.fn(async () => true),
  };
  useAuthStore.setState({ client: client as never, activeAccountId: 'acc-a' });
  usePolicyStore.setState({ subject: { email: 'a@example.org', groups: [] } });
}

afterEach(() => {
  cleanup();
  useRecoveryStore.getState().reset();
  usePolicyStore.setState(initialPolicy, true);
  useAuthStore.setState(initialAuth, true);
});

describe('retention line', () => {
  it('says how many days Trash and Junk keep mail', async () => {
    setup({ trashDays: 30, junkDays: 14 });
    const { unmount } = render(<FolderRetentionLine mailbox={TRASH} />);
    await act(async () => {});
    expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":30}');
    unmount();
    render(<FolderRetentionLine mailbox={JUNK} />);
    expect(screen.getByTestId('retention-notice').textContent).toBe('line:{"count":14}');
  });

  it('shows nothing when the admin set no days, or in other folders', async () => {
    setup({ trashDays: 0, junkDays: 0 });
    render(<FolderRetentionLine mailbox={TRASH} />);
    render(<FolderRetentionLine mailbox={JUNK} />);
    await act(async () => {});
    expect(screen.queryByTestId('retention-notice')).toBeNull();
    cleanup();
    setup({ trashDays: 30, junkDays: 30 });
    render(<FolderRetentionLine mailbox={INBOX} />);
    render(<RetentionNotice role="inbox" />);
    expect(screen.queryByTestId('retention-notice')).toBeNull();
  });

  it('shares one line with Recover deleted items in Trash', async () => {
    setup({ trashDays: 30, junkDays: 30 }, true);
    render(<FolderRetentionLine mailbox={TRASH} />);
    const line = await screen.findByTestId('trash-recovery-link');
    expect(line.querySelector('[data-testid="retention-notice"]')?.textContent).toBe('line:{"count":30}');
    expect(line.textContent).toContain('trash_link');
    expect(screen.getAllByTestId('retention-notice')).toHaveLength(1);
  });
});
