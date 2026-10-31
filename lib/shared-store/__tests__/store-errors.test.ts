import { describe, expect, it, vi } from 'vitest';

describe('isStoreUnavailableError', () => {
  it('recognises the error from another module copy, where instanceof does not', async () => {
    const first = await import('../types');
    const thrown = new first.StoreUnavailableError('down');
    vi.resetModules();
    const second = await import('../types');
    expect(thrown instanceof second.StoreUnavailableError).toBe(false);
    expect(second.isStoreUnavailableError(thrown)).toBe(true);
    expect(second.isStoreUnavailableError(new Error('other'))).toBe(false);
    expect(second.isStoreUnavailableError(null)).toBe(false);
  });
});
