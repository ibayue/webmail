import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../settings-store';

// "Show sender avatars in the message list" is a choice on the Message list
// page; it has to reach the server copy like the rest, or another device (or
// a restore) quietly goes back to drawing the avatars.
describe('settings-store showListAvatars sync', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('is in the snapshot pushed to the server and in a file export', () => {
    useSettingsStore.getState().updateSetting('showListAvatars', false);
    expect(JSON.parse(useSettingsStore.getState().exportSettings({ forSync: true })).showListAvatars).toBe(false);
    expect(JSON.parse(useSettingsStore.getState().exportSettings()).showListAvatars).toBe(false);
  });

  it('comes back from a synced copy', () => {
    useSettingsStore.getState().updateSetting('showListAvatars', false);
    const blob = useSettingsStore.getState().exportSettings({ forSync: true });
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().showListAvatars).toBe(true);
    expect(useSettingsStore.getState().importSettings(blob)).toBe(true);
    expect(useSettingsStore.getState().showListAvatars).toBe(false);
  });

  it('ignores a blob that is not JSON at all', () => {
    expect(useSettingsStore.getState().importSettings('not json')).toBe(false);
    expect(useSettingsStore.getState().showListAvatars).toBe(true);
  });
});
