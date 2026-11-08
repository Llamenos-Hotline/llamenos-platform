import { describe, expect, test } from 'bun:test';
import { platformTagVersion } from './releases';

describe('platformTagVersion', () => {
  test('reads the version-first tags CI cuts now', () => {
    expect(platformTagVersion('v0.21.8-desktop', 'desktop')).toBe('0.21.8');
    expect(platformTagVersion('v0.21.8-android', 'android')).toBe('0.21.8');
    expect(platformTagVersion('v0.22.0-rc.1-desktop', 'desktop')).toBe('0.22.0-rc.1');
  });

  test('reads the platform-first tags of releases cut before that change', () => {
    expect(platformTagVersion('desktop-v0.19.18', 'desktop')).toBe('0.19.18');
    expect(platformTagVersion('android-v0.19.18', 'android')).toBe('0.19.18');
  });

  test('rejects the API release and other platforms', () => {
    expect(platformTagVersion('v0.21.8', 'desktop')).toBeNull();
    expect(platformTagVersion('v0.21.8-android', 'desktop')).toBeNull();
    expect(platformTagVersion('v0.21.8-ios', 'android')).toBeNull();
    expect(platformTagVersion('android-v0.21.8', 'desktop')).toBeNull();
  });
});
