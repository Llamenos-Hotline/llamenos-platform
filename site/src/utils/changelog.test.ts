import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseChangelog, tokenizeEntry } from './changelog';

describe('parseChangelog', () => {
  const raw = [
    '# Changelog',
    '## [Unreleased]',
    '### Added',
    '- not a release',
    '## [0.9.0] - 2026-02-18',
    '### Bug Fixes',
    '- legacy entry',
    '## 0.19.19 (2026-10-18)',
    '### Features',
    '- knope entry (#12)',
    '### Fixes',
    '## 0.10.0 (2026-03-01)',
    '### Fixes',
    '- a',
    '- b',
  ].join('\n');

  test('reads both heading styles, skips Unreleased, sorts by semver descending', () => {
    expect(parseChangelog(raw).map(r => r.version)).toEqual(['0.19.19', '0.10.0', '0.9.0']);
  });

  test('keeps date and grouped entries, dropping empty sections', () => {
    const [top, mid] = parseChangelog(raw);
    expect(top).toEqual({
      version: '0.19.19',
      date: '2026-10-18',
      sections: [{ title: 'Features', items: ['knope entry (#12)'] }],
    });
    expect(mid.sections[0].items).toEqual(['a', 'b']);
  });

  test('parses the real CHANGELOG.md, newest release first', () => {
    const releases = parseChangelog(readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'));
    expect(releases.length).toBeGreaterThan(0);
    for (const r of releases) {
      expect(r.sections.length).toBeGreaterThan(0);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const versions = releases.map(r => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('tokenizeEntry', () => {
  test('splits code spans and issue references, leaving other text verbatim', () => {
    expect(tokenizeEntry('fix `a<b>` crash (#42)')).toEqual([
      { kind: 'text', value: 'fix ' },
      { kind: 'code', value: 'a<b>' },
      { kind: 'text', value: ' crash (' },
      { kind: 'ref', number: 42 },
      { kind: 'text', value: ')' },
    ]);
  });

  test('does not treat markup or URL fragments as references', () => {
    expect(tokenizeEntry('<script>x</script> see http://x/#12')).toEqual([
      { kind: 'text', value: '<script>x</script> see http://x/#12' },
    ]);
  });
});
