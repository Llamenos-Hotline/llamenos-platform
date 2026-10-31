#!/usr/bin/env bun
/**
 * Untranslated-value gate (#2335). See tools/untranslated.ts for the rules.
 *
 * Usage:
 *   bun run i18n:untranslated                    # compare against merge-base(HEAD, origin/main)
 *   bun run i18n:untranslated --base origin/main # name the base ref explicitly
 *
 * Exit 0: nothing introduced by this change is untranslated (backlog is reported).
 * Exit 1: this change adds or alters a value that is verbatim English, or a
 *         `_same_as_en` marker is invalid.
 * Exit 2: the merge base cannot be resolved. The gate fails closed -- it never
 *         degrades to "nothing to compare, so fine".
 *
 * The baseline is read from git at the merge base. There is no committed
 * snapshot file.
 *
 * When $GITHUB_STEP_SUMMARY is set the report is appended to it, so the
 * backlog count is on every run.
 */

import { appendFileSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { LANGUAGES } from '../languages'
import { analyse, isFailing, renderReport, snapshotFromJson, type CatalogueSnapshot } from './untranslated'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = resolve(__dirname, '../locales')
const REPO_ROOT = resolve(__dirname, '../../..')
const LOCALES_REPO_PATH = 'packages/i18n/locales'

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function fail(code: number, message: string): never {
  console.error(message)
  process.exit(code)
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

function loadCurrent(codes: string[]): { snapshot: CatalogueSnapshot; errors: string[] } {
  const read = (code: string) => JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Record<string, unknown>
  const locales = new Map(codes.map(code => [code, read(code)] as const))
  return snapshotFromJson(read('en'), locales)
}

function loadAtRev(rev: string, codes: string[]): CatalogueSnapshot {
  // A locale that does not exist at the base (a brand-new locale) is left out of
  // the snapshot; `analyse` then reports it as having no baseline.
  const show = (code: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(git('show', `${rev}:${LOCALES_REPO_PATH}/${code}.json`)) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const en = show('en')
  if (!en) fail(2, `Cannot read ${LOCALES_REPO_PATH}/en.json at ${rev}.`)
  const locales = new Map<string, Record<string, unknown>>()
  for (const code of codes) {
    const data = show(code)
    if (data) locales.set(code, data)
  }
  return snapshotFromJson(en, locales).snapshot
}

const baseRef = argValue('--base') ?? 'origin/main'
let mergeBase: string
try {
  mergeBase = git('merge-base', 'HEAD', baseRef).trim()
} catch (e) {
  fail(
    2,
    `Cannot resolve the merge base of HEAD and "${baseRef}": ${(e as Error).message.split('\n')[0]}\n` +
    'The untranslated-value gate compares against the merge base and refuses to run without one. ' +
    'Fetch full history (actions/checkout fetch-depth: 0) or pass --base <ref>.'
  )
}

const codes = LANGUAGES.map(l => l.code)
const nonEn = codes.filter(c => c !== 'en')
const current = loadCurrent(nonEn)
const base = loadAtRev(mergeBase, nonEn)
const report = analyse(current.snapshot, base)
report.errors.unshift(...current.errors)

const markdown = renderReport(report, mergeBase.slice(0, 12))
console.log(markdown)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)

if (isFailing(report)) {
  console.error('i18n untranslated-value gate FAILED -- see "Blocking" above.')
  process.exit(1)
}
console.log('i18n untranslated-value gate passed (backlog reported above, not blocking).')
