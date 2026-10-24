/**
 * Isolation-pattern tests — verify the packaged app's IPC allowlist
 * (apps/desktop/isolation/index.html) lets the realtime relay's event channel
 * (listen and unlisten) through and nothing broader.
 *
 * These MUST run against the real packaged binary: `tauri:dev` and the
 * Playwright IPC mock both bypass the isolation iframe, which is exactly how
 * `plugin:event|listen` was missing from the allowlist (#2107) while every
 * other suite stayed green — the relay never connected in a shipped build and
 * every realtime path silently fell back to the 15 s REST poll.
 *
 * In a packaged build a command the policy refuses never settles (it hangs
 * rather than rejecting), so "refused" is asserted as "did not settle within
 * the window", and "allowed" as "resolved with an event id".
 */

/** How long a refused command is given to (not) settle. */
const REFUSED_WINDOW_MS = 3_000

type Outcome = { settled: true; value: unknown } | { settled: false } | { settled: true; error: string }

async function listen(event: string): Promise<Outcome> {
  return browser.execute(
    async (name: string, windowMs: number) => {
      const internals = window.__TAURI_INTERNALS__ as unknown as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
        transformCallback: (cb: () => void) => number
      }
      const call = internals
        .invoke('plugin:event|listen', {
          event: name,
          target: { kind: 'Any' },
          handler: internals.transformCallback(() => {}),
        })
        .then(
          (value) => ({ settled: true as const, value }),
          (e) => ({ settled: true as const, error: String(e) }),
        )
      const timeout = new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), windowMs),
      )
      return Promise.race([call, timeout])
    },
    event,
    REFUSED_WINDOW_MS,
  ) as Promise<Outcome>
}

/**
 * Subscribe, then release the subscription the way `@tauri-apps/api`'s stock
 * `listen()` unlisten function does: `plugin:event|unlisten` with
 * `{ event, eventId }`, where `eventId` is what `listen` resolved with (#2130).
 * Resolves with the outcome of the UNLISTEN call.
 */
async function listenThenUnlisten(event: string): Promise<Outcome> {
  return browser.execute(
    async (name: string, windowMs: number) => {
      const internals = window.__TAURI_INTERNALS__ as unknown as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
        transformCallback: (cb: () => void) => number
      }
      const eventId = await internals.invoke('plugin:event|listen', {
        event: name,
        target: { kind: 'Any' },
        handler: internals.transformCallback(() => {}),
      })
      const call = internals.invoke('plugin:event|unlisten', { event: name, eventId }).then(
        (value) => ({ settled: true as const, value }),
        (e) => ({ settled: true as const, error: String(e) }),
      )
      const timeout = new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), windowMs),
      )
      return Promise.race([call, timeout])
    },
    event,
    REFUSED_WINDOW_MS,
  ) as Promise<Outcome>
}

describe('IPC isolation policy: event channel', () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function')) === true,
      { timeout: 10_000, timeoutMsg: '__TAURI_INTERNALS__ not available after 10s' },
    )
  })

  it('lets the relay subscribe to its net-ws channel (#2107)', async () => {
    const outcome = await listen(`net-ws:${'0b6f3c1e-8a52-4d0e-9f41-0c2d7a9e5b13'}`)
    expect(outcome).toEqual({ settled: true, value: expect.any(Number) })
  })

  it('lets the relay release its net-ws subscription (unlisten, #2130)', async () => {
    const outcome = await listenThenUnlisten(`net-ws:${'0b6f3c1e-8a52-4d0e-9f41-0c2d7a9e5b13'}`)
    // `unlisten` resolves with no value; what matters is that it SETTLED, not hung.
    expect(outcome.settled).toBe(true)
    expect('error' in outcome).toBe(false)
  })

  it('lets the tray "check for updates" event through', async () => {
    const outcome = await listen('check-for-updates')
    expect(outcome).toEqual({ settled: true, value: expect.any(Number) })
  })

  it('does not let the webview subscribe to arbitrary native events', async () => {
    const outcome = await listen('tauri://window-created')
    expect(outcome.settled && 'value' in outcome).toBe(false)
  })
})
