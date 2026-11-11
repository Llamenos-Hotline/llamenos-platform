// The console-error guard has to actually fail on a real page error (#1858).
// A guard nobody has seen fail is a green light wired to nothing.
//
// Deliberately takes `test` from '@playwright/test', not from the guard: these
// tests drive the watcher by hand and assert on what it reports, so the guard's
// own auto-fixture must not fail them for the errors they provoke.
import { test, expect } from '@playwright/test'
import { watchConsole } from './console-guard'

test.describe('console-error guard', () => {
  test('a console.error from the page is reported and assertClean throws', async ({ page, context }) => {
    const watch = watchConsole(context)
    await page.setContent('<script>console.error("something went wrong in the app")</script>')
    await expect.poll(() => watch.unexpected().length).toBe(1)
    expect(() => watch.assertClean()).toThrow(/something went wrong in the app/)
  })

  test('an uncaught exception is reported and assertClean throws', async ({ page, context }) => {
    const watch = watchConsole(context)
    await page.setContent('<script>setTimeout(() => { throw new Error("uncaught boom") })</script>')
    await expect.poll(() => watch.unexpected().length).toBe(1)
    expect(watch.unexpected()[0].kind).toBe('pageerror')
    expect(() => watch.assertClean()).toThrow(/uncaught boom/)
  })

  test('a page opened later in the same context is watched too', async ({ context }) => {
    const watch = watchConsole(context)
    const popup = await context.newPage()
    await popup.setContent('<script>console.error("from a second page")</script>')
    await expect.poll(() => watch.unexpected().length).toBe(1)
  })

  test('a row scoped to a request does not tolerate a console.error the page logs itself', async ({ page, context }) => {
    const watch = watchConsole(context)
    watch.expect({
      message: /^declared failure$/,
      source: /\/declared$/,
      reason: 'the test provokes it',
    })
    await page.setContent('<script>console.error("declared failure")</script>')
    await expect.poll(() => watch.all().length).toBe(1)
    // The message matches, the source (about:srcdoc / the page) does not.
    expect(watch.unexpected()).toHaveLength(1)
    expect(() => watch.assertClean()).toThrow(/declared failure/)
  })

  test('a declaration needs a reason', async ({ context }) => {
    const watch = watchConsole(context)
    expect(() => watch.expect({ message: /x/, source: /x/, reason: ' ' })).toThrow(/needs a reason/)
  })

  test('an uncaught exception can never be declared tolerable', async ({ page, context }) => {
    const watch = watchConsole(context)
    watch.expect({ message: /.*/, source: /.*/, reason: 'a catch-all, to prove it still does not hide a pageerror' })
    await page.setContent('<script>setTimeout(() => { throw new Error("still uncaught") })</script>')
    await expect.poll(() => watch.all().length).toBe(1)
    expect(() => watch.assertClean()).toThrow(/still uncaught/)
  })

  test('an HTTP error from a declared request is tolerated, the same status from another request is not', async ({ page, context }) => {
    const watch = watchConsole(context)
    watch.expect({
      message: /^Failed to load resource: the server responded with a status of 502 \(Bad Gateway\)$/,
      source: /\/api\/declared$/,
      reason: 'the test injects it',
    })
    await page.route('http://guard.test/**', (route) => {
      const url = route.request().url()
      return url.endsWith('/')
        ? route.fulfill({ status: 200, contentType: 'text/html', body: '<img src="/api/declared"><img src="/api/other">' })
        : route.fulfill({ status: 502, body: 'bad' })
    })
    await page.goto('http://guard.test/')
    await expect.poll(() => watch.all().length).toBe(2)
    expect(watch.unexpected().map((f) => f.source)).toEqual(['http://guard.test/api/other'])
    expect(watch.tolerated().map((t) => t.finding.source)).toEqual(['http://guard.test/api/declared'])
    expect(() => watch.assertClean()).toThrow(/api\/other/)
  })
})
