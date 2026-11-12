/**
 * Console-error guard for the desktop E2E suite (#1858).
 *
 * A page that throws, or that logs `console.error`, is a defect signal. The
 * suite used to emit ~544 `console.error` events per run — almost all of them
 * test-harness artefacts (synthetic hub IDs whose background polling 404'd; see
 * `mockBackgroundHubReads` in ./helpers.ts) — which made a genuine page error
 * undetectable among them. With that noise removed at its source, every spec
 * that imports `test` from here now FAILS on an unexpected console error or any
 * uncaught page exception.
 *
 * What keeps this honest — there is no "ignore all errors" switch:
 *
 *  - `pageerror` (an uncaught exception / unhandled rejection) can never be
 *    tolerated.
 *  - A `console.error` is tolerated only when it matches a row that names BOTH
 *    the message and the request it is attributed to, and says why it is
 *    correct behaviour. Rows are either global (`EXPECTED_CONSOLE_ERRORS`) or
 *    declared by the one test that provokes the failure on purpose
 *    (`consoleWatch.expect(...)`).
 *  - Every tolerated error is recorded on the test as an annotation, so a
 *    defence that is firing is visible in the report instead of silent.
 *
 * Specs import `test` / `expect` from here instead of '@playwright/test';
 * `tests/guards.test.ts` fails if a browser spec forgets to.
 */

import {
  expect,
  test as base,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
} from '@playwright/test'

export { expect }

export interface ConsoleFinding {
  readonly kind: 'console.error' | 'pageerror'
  readonly text: string
  /** The resource the browser attributes the message to (a failed request's URL, or a page URL). */
  readonly source: string
}

export interface ExpectedConsoleError {
  /** Matches the message text the browser produced. */
  readonly message: RegExp
  /** Matches the URL the message is attributed to. Required — a message alone is never enough. */
  readonly source: RegExp
  /** Why this error is correct behaviour and not a defect. */
  readonly reason: string
}

/**
 * Console errors that are the app behaving correctly in EVERY test. Keep this
 * short and specific: each row must be justified against the code producing it.
 * A test that provokes a failure on purpose declares it with
 * `consoleWatch.expect(...)` instead of adding a row here.
 */
export const EXPECTED_CONSOLE_ERRORS: readonly ExpectedConsoleError[] = [
  {
    // Chromium logs every non-2xx response, whether or not the app handles it.
    // This one is the API contract: A2P status is 404 when the hub has no
    // registration (apps/worker/routes/provider-setup.ts) and
    // src/client/lib/api/a2p.ts turns that 404 into `null`.
    message: /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    source: /\/api\/provider-setup\/a2p\/status(\?|$)/,
    reason: 'no A2P registration is a 404 by contract; the client maps it to null',
  },
  {
    // Chromium aborts in-flight requests with this when ANY host network
    // interface changes (a container starting, a VPN reconnecting). It says
    // nothing about the page, and a load that genuinely needed the resource
    // fails its own assertion anyway.
    message: /^Failed to load resource: net::ERR_NETWORK_CHANGED$/,
    source: /^https?:\/\/[^/]+\/(assets|api)\//,
    reason: 'the host network changed under the browser; environmental, not the page',
  },
]

export interface ConsoleWatch {
  /**
   * Declare that THIS test provokes a console error on purpose (an injected 502,
   * an aborted request, a mocked 409). Narrow to the exact message and request.
   */
  readonly expect: (row: ExpectedConsoleError) => void
  /** Everything captured so far, tolerated or not. */
  readonly all: () => readonly ConsoleFinding[]
  /** Captured findings that no row tolerates. */
  readonly unexpected: () => readonly ConsoleFinding[]
  /** Findings a row tolerated, with the row's reason. */
  readonly tolerated: () => ReadonlyArray<{ finding: ConsoleFinding; reason: string }>
  /** Throws if anything unexpected was captured. */
  readonly assertClean: () => void
}

function describeFinding(f: ConsoleFinding): string {
  return `[${f.kind}] ${f.text}${f.source ? `\n      at ${f.source}` : ''}`
}

/**
 * Watch every page of a context — those open now and those opened later
 * (popups, `context.newPage()`). The default `page`/`context` fixtures of the
 * `test` exported below are already watched; call this directly for a context a
 * spec creates itself with `browser.newContext()`.
 */
export function watchConsole(context: BrowserContext): ConsoleWatch {
  const findings: ConsoleFinding[] = []
  const declared: ExpectedConsoleError[] = []

  const attach = (page: Page) => {
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return
      findings.push({ kind: 'console.error', text: msg.text(), source: msg.location().url })
    })
    page.on('pageerror', (error) => {
      findings.push({ kind: 'pageerror', text: error.stack ?? error.message, source: page.url() })
    })
  }
  context.pages().forEach(attach)
  context.on('page', attach)

  const reasonFor = (f: ConsoleFinding): string | undefined => {
    if (f.kind !== 'console.error') return undefined
    return [...EXPECTED_CONSOLE_ERRORS, ...declared].find(
      (row) => row.message.test(f.text) && row.source.test(f.source),
    )?.reason
  }

  const unexpected = () => findings.filter((f) => reasonFor(f) === undefined)
  const tolerated = () =>
    findings.flatMap((finding) => {
      const reason = reasonFor(finding)
      return reason === undefined ? [] : [{ finding, reason }]
    })

  return {
    expect: (row) => {
      if (row.reason.trim() === '') throw new Error('consoleWatch.expect() needs a reason')
      declared.push(row)
    },
    all: () => findings,
    unexpected,
    tolerated,
    assertClean: () => {
      const bad = unexpected()
      if (bad.length === 0) return
      throw new Error(
        `${bad.length} unexpected console error(s) / page exception(s) during the test:\n  ` +
          bad.map(describeFinding).join('\n  '),
      )
    },
  }
}

/** Record tolerated errors on the running test so they stay visible in the report. */
export function annotateTolerated(watch: ConsoleWatch): void {
  const seen = new Set<string>()
  for (const { finding, reason } of watch.tolerated()) {
    const description = `${finding.text} @ ${finding.source} — ${reason}`
    if (seen.has(description)) continue
    seen.add(description)
    base.info().annotations.push({ type: 'console-error-tolerated', description })
  }
}

/**
 * End-of-test check shared by every fixture that watches a context. A test that
 * already failed keeps its own error as the headline: console errors that follow
 * a failure (sessions torn down, polls refused) are attached to it, not thrown
 * on top of it.
 */
export async function settleConsoleWatch(watch: ConsoleWatch): Promise<void> {
  annotateTolerated(watch)
  const info = base.info()
  if (info.status !== 'passed' && info.status !== undefined) {
    const bad = watch.unexpected()
    if (bad.length > 0) {
      await info.attach('console-errors', {
        body: bad.map(describeFinding).join('\n'),
        contentType: 'text/plain',
      })
    }
    return
  }
  watch.assertClean()
}

export const test = base.extend<{ consoleWatch: ConsoleWatch }>({
  consoleWatch: [
    async ({ context }, use) => {
      const watch = watchConsole(context)
      await use(watch)
      await settleConsoleWatch(watch)
    },
    { auto: true },
  ],
})
