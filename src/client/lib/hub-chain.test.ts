/**
 * The desktop hub-chain gate (#2963): what loading a hub's chain concludes, and
 * that sealing in a hub fails CLOSED unless this device verified its chain.
 *
 * The crate's own verdicts (which chains are forks, which links unauthorised)
 * are pinned by the vectors through the production readers — the Tauri command
 * test in apps/desktop/src/crypto.rs and the bun:ffi reader. Here the crate
 * call is stubbed to answer as the crate does, and what is under test is this
 * module's handling of those answers: anchors, verdicts, the sealing gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pages: [] as { links: unknown[]; head: unknown; hasMore: boolean }[],
  anchors: new Map<string, { seq: number; hash: string }>(),
  verify: vi.fn(),
  fetchFails: false,
}))

vi.mock('./api', () => ({
  getHubChainPage: vi.fn(async () => {
    if (mocks.fetchFails) throw new Error('network down')
    return mocks.pages.shift() ?? { links: [], head: null, hasMore: false }
  }),
  getSigchain: vi.fn(async () => ({ links: [] })),
  appendHubChainLink: vi.fn(),
  createHub: vi.fn(),
  getHubFounding: vi.fn(),
}))
vi.mock('./platform', () => ({
  getHubChainAnchor: vi.fn(async (hub: string) => mocks.anchors.get(hub) ?? null),
  setHubChainAnchor: vi.fn(async (hub: string, head: { seq: number; hash: string }) => { mocks.anchors.set(hub, head) }),
  hubChainCall: vi.fn(async (_op: string, req: unknown) => mocks.verify(req)),
  hubChainSignLink: vi.fn(),
  getDevicePubkeys: vi.fn(),
}))
vi.mock('./user-identity', () => ({ assertExtendsVerifiedHead: vi.fn(), initializeUserIdentity: vi.fn(), recordVerifiedHead: vi.fn(), toCryptoSigchainLink: (l: unknown) => l }))

const { assertHubSealable, HubSealingStoppedError, loadHubChain } = await import('./hub-chain')

const H = (n: number) => n.toString(16).padStart(64, '0')
const link = (hub: string, seq: number) => ({ hub, seq, entryHash: H(seq), signerUser: H(99), body: { type: seq === 1 ? 'genesis' : 'policy' } })
const verified = (hub: string, seq: number) => ({ hub, head: { seq, hash: H(seq) }, state: {}, stateHash: H(0), alerts: [] })

let hubCounter = 0
function newHub(): string {
  hubCounter += 1
  return `hub-${hubCounter}`
}

beforeEach(() => {
  mocks.pages = []
  mocks.fetchFails = false
  mocks.verify.mockReset()
})

describe('loadHubChain', () => {
  it('verifies through the crate against the stored anchor, then advances the anchor', async () => {
    const hub = newHub()
    mocks.anchors.set(hub, { seq: 1, hash: H(1) })
    mocks.pages = [{ links: [link(hub, 1), link(hub, 2)], head: null, hasMore: false }]
    mocks.verify.mockReturnValue(verified(hub, 2))
    const status = await loadHubChain(hub)
    expect(status.kind).toBe('verified')
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ anchor: { seq: 1, hash: H(1) } }))
    expect(mocks.anchors.get(hub)).toEqual({ seq: 2, hash: H(2) })
    await expect(assertHubSealable(hub)).resolves.toBeUndefined()
  })

  it('records a fork when the crate refuses with chain_fork, keeps the anchor, and stops sealing', async () => {
    const hub = newHub()
    mocks.anchors.set(hub, { seq: 2, hash: H(2) })
    mocks.pages = [{ links: [link(hub, 1), link(hub, 2)], head: null, hasMore: false }]
    mocks.verify.mockRejectedValue(new Error('chain_fork: the served chain has a different link at the trusted seq 2'))
    expect((await loadHubChain(hub)).kind).toBe('fork')
    expect(mocks.anchors.get(hub)).toEqual({ seq: 2, hash: H(2) })
    await expect(assertHubSealable(hub)).rejects.toBeInstanceOf(HubSealingStoppedError)
  })

  it('records an unauthorised link as refused and stops sealing', async () => {
    const hub = newHub()
    mocks.pages = [{ links: [link(hub, 1), link(hub, 2)], head: null, hasMore: false }]
    mocks.verify.mockRejectedValue(new Error('chain_unauthorised_signer: x may not sign a role_grant link at seq 2'))
    expect(await loadHubChain(hub)).toMatchObject({ kind: 'refused', code: 'chain_unauthorised_signer' })
    await expect(assertHubSealable(hub)).rejects.toBeInstanceOf(HubSealingStoppedError)
  })

  it('refuses a valid chain of ANOTHER hub served for this one', async () => {
    const hub = newHub()
    mocks.pages = [{ links: [link(hub, 1)], head: null, hasMore: false }]
    mocks.verify.mockReturnValue(verified('some-other-hub', 1))
    expect(await loadHubChain(hub)).toMatchObject({ kind: 'refused', code: 'chain_hub_mismatch' })
    expect(mocks.anchors.has(hub)).toBe(false)
  })

  it('treats an empty chain as a fork once this device holds an anchor for the hub', async () => {
    const hub = newHub()
    mocks.anchors.set(hub, { seq: 3, hash: H(3) })
    expect((await loadHubChain(hub)).kind).toBe('fork')
  })

  it('fetches every page forward', async () => {
    const hub = newHub()
    mocks.pages = [
      { links: [link(hub, 1)], head: null, hasMore: true },
      { links: [link(hub, 2)], head: null, hasMore: false },
    ]
    mocks.verify.mockReturnValue(verified(hub, 2))
    await loadHubChain(hub)
    expect(mocks.verify.mock.calls[0][0].links).toHaveLength(2)
  })
})

describe('assertHubSealable fails closed', () => {
  it('loads and verifies the chain first when this device has no verdict yet', async () => {
    const hub = newHub()
    mocks.pages = [{ links: [link(hub, 1)], head: null, hasMore: false }]
    mocks.verify.mockReturnValue(verified(hub, 1))
    await expect(assertHubSealable(hub)).resolves.toBeUndefined()
    expect(mocks.verify).toHaveBeenCalledTimes(1)
  })

  it('refuses to seal in a hub the server says has no chain', async () => {
    const hub = newHub()
    expect((await loadHubChain(hub)).kind).toBe('none')
    await expect(assertHubSealable(hub)).rejects.toBeInstanceOf(HubSealingStoppedError)
  })

  it('refuses to seal when the chain cannot be fetched', async () => {
    const hub = newHub()
    mocks.fetchFails = true
    await expect(assertHubSealable(hub)).rejects.toThrow('network down')
  })
})
