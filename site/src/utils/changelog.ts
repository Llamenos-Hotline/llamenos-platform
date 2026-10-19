/**
 * Build-time parse of the repository's CHANGELOG.md.
 *
 * The file is maintained by knope and is the only source for the changelog
 * page — there is deliberately no runtime fetch. A visitor's browser must never
 * contact GitHub merely to read about a crisis-response tool: that request is
 * implicating metadata (see pages/changelog.astro).
 *
 * Two heading styles coexist in the file:
 *   `## [0.19.2] - 2026-02-27`   hand-written/legacy entries (<= 0.19.2)
 *   `## 0.19.19 (2026-10-18)`    knope-generated entries
 * `## [Unreleased]` is a pre-knope placeholder, not a release, and is skipped.
 */

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

const LEGACY_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
const KNOPE_HEADING = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)\s*$/;
const SECTION_HEADING = /^### (.+?)\s*$/;
const ITEM = /^- (.+?)\s*$/;

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

export function parseChangelog(raw: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const m = LEGACY_HEADING.exec(line) ?? KNOPE_HEADING.exec(line);
      release = m ? { version: m[1], date: m[2], sections: [] } : null;
      section = null;
      if (release) releases.push(release);
      continue;
    }
    if (!release) continue;

    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      section = { title: heading[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const item = ITEM.exec(line);
    if (item && section) section.items.push(item[1]);
  }

  return releases
    .map(r => ({ ...r, sections: r.sections.filter(s => s.items.length > 0) }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
}

/** A piece of an entry: plain text, `inline code`, or a #123 issue/PR reference. */
export type EntryToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'ref'; number: number };

/**
 * Split an entry into tokens so the page can render code spans and link
 * issue/PR references without `set:html` — commit subjects are free text and
 * must never be injected as markup.
 */
export function tokenizeEntry(text: string): EntryToken[] {
  const tokens: EntryToken[] = [];
  const pattern = /`([^`]+)`|(?<![\w/&])#(\d+)\b/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ kind: 'text', value: text.slice(last, start) });
    if (m[1] !== undefined) tokens.push({ kind: 'code', value: m[1] });
    else tokens.push({ kind: 'ref', number: Number(m[2]) });
    last = start + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}
