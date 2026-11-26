/**
 * Compare what i18n codegen WOULD write against what is on disk (#1901).
 *
 * Every i18n codegen output is gitignored, so `git diff` cannot see it: a
 * hand-edited or stale Localizable.strings / strings.xml / I18n.kt reads as
 * "no changes" to git no matter what it contains. This compares bytes instead.
 *
 * A root names a directory and the files inside it that codegen owns. An owned
 * file on disk that codegen did not produce is an orphan (a renamed or removed
 * locale's leftovers, which the app would still load) and is reported too.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

export interface OutputRoot {
  /** Absolute directory codegen writes under. */
  dir: string
  /** Does codegen own this file? `rel` is relative to `dir`, `/`-separated. */
  owns: (rel: string) => boolean
}

export type OutputProblemKind = 'missing' | 'stale' | 'orphan'

export interface OutputProblem {
  kind: OutputProblemKind
  path: string
}

/** Owned files under a root, at most `depth` directory levels down. */
function ownedFilesOnDisk(root: OutputRoot, depth = 2): string[] {
  const found: string[] = []
  function walk(dir: string, level: number) {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (level < depth) walk(full, level + 1)
        continue
      }
      if (root.owns(relative(root.dir, full).split('\\').join('/'))) found.push(full)
    }
  }
  walk(root.dir, 0)
  return found
}

/**
 * Every way the files on disk differ from `expected` (absolute path -> content).
 * An empty result means the on-disk output is exactly what codegen produces.
 */
export function compareOutputs(expected: ReadonlyMap<string, string>, roots: readonly OutputRoot[]): OutputProblem[] {
  const problems: OutputProblem[] = []
  for (const [path, content] of expected) {
    if (!existsSync(path)) problems.push({ kind: 'missing', path })
    else if (readFileSync(path, 'utf-8') !== content) problems.push({ kind: 'stale', path })
  }
  for (const root of roots) {
    for (const path of ownedFilesOnDisk(root)) {
      if (!expected.has(path)) problems.push({ kind: 'orphan', path })
    }
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
}
