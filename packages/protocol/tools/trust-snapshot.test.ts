// @suite: repo
/**
 * The trust snapshot (#3069): what it must catch, what it must leave alone, and
 * that the values it records are the values the certificates derive.
 *
 * Three kinds of test, because a gate is only evidence once it has been shown to
 * go red on purpose AND to stay green on the diffs it must not hold:
 *
 *  1. DERIVED, NOT DECIDED — every platform's pinned set equals the pins derived
 *     from real certificates, from three independent fixture sets (Android PEMs,
 *     desktop DER, iOS base64). A value that equals its derivation needs no human.
 *  2. BREAK IT — for each class of trust defect, the real defect is injected into
 *     the real shipped sources (in memory) and the snapshot must move.
 *  3. NO NOISE — the kinds of diff that used to demand a TLS signature for
 *     nothing (#3051, #3060, a `project.yml` source entry) must NOT move it.
 *
 *   bun test packages/protocol/tools/trust-snapshot.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { X509Certificate, createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import {
  SIGNOFF_LEDGER_PATH, SNAPSHOT_PATH, TrustExtractionError, diffSnapshots, extractTrustSnapshot, fsReader, functionBodies, gitReader,
  parsePlist, parseXml, readSignoffs, releaseVerdict, serializeSnapshot, snapshotDigest, stripComments, stripRustTests,
  type TreeReader, type TrustSnapshot,
} from './trust-snapshot'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const real = fsReader(ROOT)
const baseline = extractTrustSnapshot(real)
const baselineDigest = snapshotDigest(baseline)

const PREFIXES = ['apps/android/app/src/', 'apps/android/app/build.gradle.kts', 'apps/ios/Sources/', 'apps/ios/Resources/', 'apps/ios/project.yml', 'apps/desktop/src/']

/** The real tree with `edits` applied to files that exist and `extra` files added. */
function edited(edits: Record<string, (text: string) => string>, extra: Record<string, string> = {}): TreeReader {
  return {
    list: (prefixes) => [...new Set([...real.list(prefixes), ...Object.keys(extra).filter((p) => prefixes.some((x) => p.startsWith(x.replace(/\/$/, ''))))])].sort(),
    read(path) {
      if (extra[path] !== undefined) return extra[path]
      const text = real.read(path)
      const edit = edits[path]
      if (edit === undefined || text === undefined) return text
      const out = edit(text)
      if (out === text) throw new Error(`the edit to ${path} matched nothing — a mutation that changes nothing proves nothing`)
      return out
    },
  }
}

/** Replace exactly one occurrence; fail loudly when the sentinel text is gone. */
const swap = (from: string | RegExp, to: string) => (text: string): string => {
  const out = text.replace(from, to)
  if (out === text) throw new Error(`mutation anchor not found: ${String(from)}`)
  return out
}

const find = (marker: string, prefixes: readonly string[] = PREFIXES): string => {
  const hit = real.list(prefixes).find((f) => (real.read(f) ?? '').includes(marker))
  if (hit === undefined) throw new Error(`no tracked file contains ${marker}`)
  return hit
}

const NSC = 'apps/android/app/src/main/res/xml/network_security_config.xml'
const MANIFEST = 'apps/android/app/src/main/AndroidManifest.xml'
const INFO_PLIST = 'apps/ios/Sources/App/Info.plist'
const PROJECT_YML = 'apps/ios/project.yml'
const IOS_PINNING = 'apps/ios/Sources/Services/CertificatePinning.swift'
const DESKTOP_CERT_PIN = 'apps/desktop/src/cert_pin.rs'
const DESKTOP_API_CONFIG = 'apps/desktop/src/api_config.rs'
const DESKTOP_NET = 'apps/desktop/src/net.rs'
// The file that holds DEFAULT_PIN_HASHES, wherever the Android client keeps it.
const ANDROID_PIN_FILE = find('val DEFAULT_PIN_HASHES')
const ANDROID_WS = 'apps/android/app/src/main/java/org/llamenos/hotline/api/WebSocketService.kt'
const ANDROID_API = 'apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt'

/** The snapshot of the edited tree must differ, and the diff must name `mention`. */
function expectMoves(tree: TreeReader, mention: RegExp): void {
  const after = extractTrustSnapshot(tree)
  expect(snapshotDigest(after)).not.toBe(baselineDigest)
  const diff = diffSnapshots(baseline, after).join('\n')
  expect(diff).toMatch(mention)
}

function expectUnchanged(tree: TreeReader): void {
  const after = extractTrustSnapshot(tree)
  expect(diffSnapshots(baseline, after)).toEqual([])
  expect(snapshotDigest(after)).toBe(baselineDigest)
}

// ---------------------------------------------------------------------------
// 0. The committed snapshot is the tree's snapshot
// ---------------------------------------------------------------------------

describe('the committed snapshot', () => {
  test('is exactly what the tree extracts to — a PR that moves a trust value moves this file with it', () => {
    expect(existsSync(join(ROOT, SNAPSHOT_PATH))).toBe(true)
    const committed = readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8')
    const extracted = serializeSnapshot(baseline)
    // Say WHAT is stale, not just that it is: this output is what a PR author reads.
    expect(diffSnapshots(JSON.parse(committed), baseline)).toEqual([])
    expect(committed).toBe(extracted)
  })

  test('reads the same from git objects as from the working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trust-git-'))
    for (const f of real.list(PREFIXES)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      cpSync(join(ROOT, f), join(dir, f))
    }
    const run = (...a: string[]): void => {
      const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    }
    run('init', '-q')
    run('add', '-A')
    run('commit', '-q', '-m', 'tree')
    expect(extractTrustSnapshot(gitReader(dir, 'HEAD'))).toEqual(baseline)
  })
})

// ---------------------------------------------------------------------------
// 1. Derived, not decided
// ---------------------------------------------------------------------------

/** base64(SHA-256(DER SubjectPublicKeyInfo)) — RFC 7469, what `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64` prints. */
const pinOf = (cert: X509Certificate): string =>
  createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')

/**
 * WHICH roots are pinned is the one judgement in this file, and it is made here,
 * in one visible place: all four ISRG roots, because a platform trust store that
 * anchors YR/YE would take X1/X2 off the validated chain (#2505, and the Gen-Y
 * reasoning in the Android client's pin source). Deriving a hash is mechanical;
 * choosing this list is not, so changing it is a deliberate edit to THIS list.
 */
const PINNED_ROOTS = ['x1', 'x2', 'yr', 'ye'] as const

const ANDROID_CERTS = 'apps/android/app/src/test/resources/certs/'
const DESKTOP_CERTS = 'apps/desktop/testdata/lets-encrypt/'
const IOS_FIXTURES = 'apps/ios/Tests/Unit/CertificatePinningFixtures.swift'

const pem = (name: string): X509Certificate => new X509Certificate(readFileSync(join(ROOT, ANDROID_CERTS, name)))
const der = (name: string): X509Certificate => new X509Certificate(readFileSync(join(ROOT, DESKTOP_CERTS, name)))
const iosFixture = (name: string): X509Certificate => {
  const m = new RegExp(`static let ${name} = "([A-Za-z0-9+/=]+)"`).exec(readFileSync(join(ROOT, IOS_FIXTURES), 'utf8'))
  if (m === null) throw new Error(`iOS fixture ${name} not found`)
  return new X509Certificate(Buffer.from(m[1] as string, 'base64'))
}

const derived: Record<'android' | 'desktop' | 'ios', Record<(typeof PINNED_ROOTS)[number], string>> = {
  android: { x1: pinOf(pem('isrg-root-x1.pem')), x2: pinOf(pem('isrg-root-x2.pem')), yr: pinOf(pem('isrg-root-yr.pem')), ye: pinOf(pem('isrg-root-ye.pem')) },
  desktop: { x1: pinOf(der('isrg-root-x1.der')), x2: pinOf(der('isrg-root-x2.der')), yr: pinOf(der('isrg-root-yr.der')), ye: pinOf(der('isrg-root-ye.der')) },
  ios: { x1: pinOf(iosFixture('isrgRootX1')), x2: pinOf(iosFixture('isrgRootX2')), yr: pinOf(iosFixture('isrgRootYR')), ye: pinOf(iosFixture('isrgRootYE')) },
}
const derivedSet = (who: keyof typeof derived): string[] => PINNED_ROOTS.map((r) => derived[who][r]).sort()

describe('every committed pin equals the pin derived from a real certificate', () => {
  test('the three fixture sets are the same four certificates — one derivation, three witnesses', () => {
    expect(derived.desktop).toEqual(derived.android)
    expect(derived.ios).toEqual(derived.android)
  })

  test('the cross-signed copies carry the root keys, so one pin matches both forms', () => {
    expect(pinOf(pem('isrg-root-yr-by-x1.pem'))).toBe(derived.android.yr)
    expect(pinOf(pem('isrg-root-ye-by-x2.pem'))).toBe(derived.android.ye)
    expect(pinOf(der('isrg-root-yr-by-x1.der'))).toBe(derived.android.yr)
    expect(pinOf(der('isrg-root-ye-by-x2.der'))).toBe(derived.android.ye)
  })

  test('node and openssl derive the same pin — the derivation is the documented pipeline, not a lookalike', () => {
    for (const name of ['isrg-root-x1.pem', 'isrg-root-x2.pem', 'isrg-root-yr.pem', 'isrg-root-ye.pem']) {
      const r = spawnSync(
        'bash',
        ['-c', 'openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64'],
        { input: readFileSync(join(ROOT, ANDROID_CERTS, name)), encoding: 'utf8' },
      )
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe(pinOf(pem(name)))
    }
  })

  test('there are exactly four pinned roots, and they are four different keys', () => {
    expect(PINNED_ROOTS.length).toBe(4)
    expect(new Set(derivedSet('android')).size).toBe(4)
  })

  test('Android: the OkHttp pinner, the OS pin-set and every pin literal are the derived set', () => {
    const want = derivedSet('android')
    expect(baseline.pins.android.okhttp).toEqual(want)
    expect(baseline.pins.android.osPinSets).toEqual(want)
    expect(baseline.pins.android.literals).toEqual(want)
  })

  test('iOS: CertificatePins.pinned is the derived set', () => {
    expect(baseline.pins.ios.effective).toEqual(derivedSet('ios'))
    expect(baseline.pins.ios.literals).toEqual(derivedSet('ios'))
  })

  test('desktop: ISRG_ROOT_PINS is the derived set', () => {
    expect(baseline.pins.desktop.effective).toEqual(derivedSet('desktop'))
    expect(baseline.pins.desktop.literals).toEqual(derivedSet('desktop'))
  })

  test('the platforms pin the same set as each other', () => {
    expect(baseline.pins.ios.effective).toEqual(baseline.pins.android.okhttp)
    expect(baseline.pins.desktop.effective).toEqual(baseline.pins.android.okhttp)
  })

  test('the iOS plist and the project spec say the same thing about App Transport Security', () => {
    const plist = baseline.ios.infoPlists[INFO_PLIST]
    const app = (baseline.ios.projectYml as Record<string, { appTransportSecurity: unknown; infoPath: string | null }>)['Llamenos']
    expect(app?.appTransportSecurity).toEqual(plist)
    expect(plist).toEqual({ NSAllowsArbitraryLoads: false })
  })

  test('the release build allows no cleartext and trusts only the system store', () => {
    const nsc = baseline.android.networkSecurityConfigs[NSC] as { baseConfig: { cleartextTrafficPermitted: string; trustAnchors: string[] } }
    expect(nsc.baseConfig.cleartextTrafficPermitted).toBe('false')
    expect(nsc.baseConfig.trustAnchors).toEqual(['certificates:system'])
  })
})

// ---------------------------------------------------------------------------
// 2. Break it
// ---------------------------------------------------------------------------

const FLIP = (pin: string): string => `${pin[0] === 'A' ? 'B' : 'A'}${pin.slice(1)}`

describe('break it — each class of trust defect moves the snapshot', () => {
  const X1 = derived.android.x1

  describe('a wrong pin', () => {
    test('Android OkHttp: a mistyped hash', () => {
      expectMoves(edited({ [ANDROID_PIN_FILE]: swap(X1, FLIP(X1)) }), /pins\.android\.okhttp\[\]/)
    })
    test('Android OS pin-set: a mistyped hash', () => {
      expectMoves(edited({ [NSC]: swap(X1, FLIP(X1)) }), /pins\.android\.osPinSets\[\]/)
    })
    test('iOS: a mistyped hash', () => {
      expectMoves(edited({ [IOS_PINNING]: swap(X1, FLIP(X1)) }), /pins\.ios\.effective\[\]/)
    })
    test('desktop: a mistyped hash', () => {
      expectMoves(edited({ [DESKTOP_CERT_PIN]: swap(X1, FLIP(X1)) }), /pins\.desktop\.effective\[\]/)
    })
  })

  describe('a root removed from the set', () => {
    test('Android OkHttp: a root dropped from DEFAULT_PIN_HASHES while its constant stays defined', () => {
      expectMoves(edited({ [ANDROID_PIN_FILE]: swap(/(val DEFAULT_PIN_HASHES = listOf\([^)]*?)\s*ISRG_ROOT_YE_HASH,?/, '$1') }), /pins\.android\.okhttp\[\]/)
    })
    test('Android OS pin-set: a <pin> deleted', () => {
      expectMoves(edited({ [NSC]: swap(/<pin digest="SHA-256">[^<]*<\/pin>/, '') }), /pins\.android\.osPinSets\[\]|pinSet\.pins\[\]/)
    })
    test('Android OS pin-set: the whole <pin-set> deleted', () => {
      expectMoves(edited({ [NSC]: swap(/<pin-set expiration[\s\S]*?<\/pin-set>/, '') }), /pinSet/)
    })
    test('iOS: a root dropped from CertificatePins.pinned while its constant stays defined', () => {
      expectMoves(edited({ [IOS_PINNING]: swap(/(static let pinned: Set<String> = \[[^\]]*?),\s*isrgRootYEHash/, '$1') }), /pins\.ios\.effective\[\]/)
    })
    test('desktop: a root pin literal deleted from the table', () => {
      expectMoves(edited({ [DESKTOP_CERT_PIN]: swap(new RegExp(`\\s*"${derived.desktop.ye.replace(/[+/]/g, '\\$&')}",?`), '') }), /pins\.desktop\.effective\[\]/)
    })
  })

  describe('cleartext and OS trust', () => {
    test('usesCleartextTraffic flipped to true in the manifest', () => {
      expectMoves(edited({ [MANIFEST]: swap('<application', '<application android:usesCleartextTraffic="true"') }), /usesCleartextTraffic/)
    })
    test('the manifest stops pointing at the network security config', () => {
      expectMoves(edited({ [MANIFEST]: swap(/\s*android:networkSecurityConfig="[^"]*"/, '') }), /networkSecurityConfig/)
    })
    test('the base config permits cleartext', () => {
      expectMoves(edited({ [NSC]: swap('<base-config cleartextTrafficPermitted="false"', '<base-config cleartextTrafficPermitted="true"') }), /baseConfig\.cleartextTrafficPermitted/)
    })
    test('user-installed CAs become trust anchors', () => {
      expectMoves(edited({ [NSC]: swap('<certificates src="system" />', '<certificates src="system" /><certificates src="user" />') }), /trustAnchors/)
    })
    test('a debug-overrides section appears in the release config', () => {
      expectMoves(
        edited({ [NSC]: swap('</network-security-config>', '<debug-overrides><trust-anchors><certificates src="user"/></trust-anchors></debug-overrides></network-security-config>') }),
        /debugOverrides|elements/,
      )
    })
    test('a release-variant config that replaces the pinned one, with no pins in it', () => {
      const f = 'apps/android/app/src/release/res/xml/network_security_config.xml'
      expectMoves(
        edited({}, { [f]: '<network-security-config><base-config cleartextTrafficPermitted="true"/></network-security-config>' }),
        /apps\/android\/app\/src\/release\/res\/xml\/network_security_config\.xml/,
      )
    })
    test('a flavour manifest that re-enables cleartext', () => {
      const f = 'apps/android/app/src/staging/AndroidManifest.xml'
      expectMoves(
        edited({}, { [f]: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="true"/></manifest>' }),
        /apps\/android\/app\/src\/staging\/AndroidManifest\.xml/,
      )
    })
    test('a tools:replace on the manifest attribute', () => {
      expectMoves(edited({ [MANIFEST]: swap('<application', '<application tools:replace="android:networkSecurityConfig"') }), /tools:replace/)
    })
    test('the Gradle build re-points the resources that ship', () => {
      expectMoves(
        edited({ 'apps/android/app/build.gradle.kts': swap('sourceSets {', 'sourceSets {\n        getByName("main").res.srcDirs("src/insecure/res")') }),
        /buildWiring/,
      )
    })
  })

  describe('App Transport Security', () => {
    test('Info.plist: NSAllowsArbitraryLoads set true', () => {
      expectMoves(edited({ [INFO_PLIST]: swap(/(<key>NSAllowsArbitraryLoads<\/key>\s*)<false\/>/, '$1<true/>') }), /infoPlists/)
    })
    test('project.yml: the key it writes into the plist set true', () => {
      expectMoves(edited({ [PROJECT_YML]: swap('NSAllowsArbitraryLoads: false', 'NSAllowsArbitraryLoads: true') }), /appTransportSecurity/)
    })
    test('project.yml: an exception domain added', () => {
      expectMoves(
        edited({ [PROJECT_YML]: swap('NSAllowsArbitraryLoads: false', 'NSAllowsArbitraryLoads: false\n          NSExceptionDomains:\n            example.org:\n              NSExceptionAllowsInsecureHTTPLoads: true') }),
        /NSExceptionDomains/,
      )
    })
    test('project.yml: the target ships a different Info.plist', () => {
      expectMoves(edited({ [PROJECT_YML]: swap('path: Sources/App/Info.plist', 'path: Sources/App/Other.plist') }), /infoPath/)
    })
  })

  describe('a new connection that is not pinned', () => {
    test('Android: an OkHttpClient built with no pinner', () => {
      expectMoves(
        edited({}, { 'apps/android/app/src/main/java/org/llamenos/hotline/api/Telemetry.kt': 'package x\nval c = okhttp3.OkHttpClient.Builder().build()\n' }),
        /Telemetry\.kt/,
      )
    })
    test('Android: a client built without one, in a file that DOES apply a pinner elsewhere — the per-site record sees it', () => {
      expectMoves(
        edited({ [ANDROID_WS]: (t) => `${t}\nprivate val sidecar = OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).build()\n` }),
        /WebSocketService\.kt\.clients/,
      )
    })
    test('Android: a raw HttpURLConnection', () => {
      expectMoves(
        edited({}, { 'apps/android/app/src/main/java/org/llamenos/hotline/Raw.kt': 'package x\nfun f() = java.net.URL("https://a").openConnection() as HttpURLConnection\n' }),
        /Raw\.kt/,
      )
    })
    test('Android: a trust-everything TrustManager', () => {
      expectMoves(
        edited({}, { 'apps/android/app/src/main/java/org/llamenos/hotline/Trust.kt': 'package x\nobject T : javax.net.ssl.X509TrustManager {}\n' }),
        /Trust\.kt/,
      )
    })
    test('iOS: URLSession.shared', () => {
      expectMoves(
        edited({}, { 'apps/ios/Sources/Services/Beacon.swift': 'import Foundation\nfunc ping() async throws { _ = try await URLSession.shared.data(from: URL(string: "https://a")!) }\n' }),
        /Beacon\.swift/,
      )
    })
    test('iOS: a URLSession built without the pinning delegate', () => {
      expectMoves(
        edited({}, { 'apps/ios/Sources/Services/Beacon.swift': 'import Foundation\nlet s = URLSession(configuration: .default)\n' }),
        /Beacon\.swift/,
      )
    })
    test('desktop: reqwest::Client::new()', () => {
      expectMoves(edited({}, { 'apps/desktop/src/telemetry.rs': 'pub fn c() -> reqwest::Client { reqwest::Client::new() }\n' }), /telemetry\.rs/)
    })
    test('desktop: a client built that skips the preconfigured TLS', () => {
      expectMoves(
        edited({}, { 'apps/desktop/src/telemetry.rs': 'pub fn c() { let _ = reqwest::Client::builder().timeout(T).build(); }\n' }),
        /telemetry\.rs/,
      )
    })
    test('desktop: danger_accept_invalid_certs', () => {
      expectMoves(
        edited({}, { 'apps/desktop/src/telemetry.rs': 'pub fn c() { let _ = reqwest::Client::builder().danger_accept_invalid_certs(true); }\n' }),
        /telemetry\.rs/,
      )
    })
  })

  describe('a pinner taken away from a connection that had one', () => {
    test('Android: the relay stops applying the pinner', () => {
      expectMoves(edited({ [ANDROID_WS]: swap(/client\.newBuilder\(\)\.certificatePinner\([^\n]*\)\.build\(\)/, 'client.newBuilder().build()') }), /WebSocketService\.kt\.derived/)
    })
    test('Android: the pinner argument is swapped for the no-op', () => {
      expectMoves(edited({ [ANDROID_WS]: swap(/certificatePinner\(ApiService\.buildPinner\(host\)\)|certificatePinner\([^\n]*\)/, 'certificatePinner(CertificatePinner.DEFAULT)') }), /WebSocketService\.kt\.derived/)
    })
    test('iOS: the delegate is no longer passed to a session', () => {
      expectMoves(
        edited({ 'apps/ios/Sources/Services/WebSocketService.swift': swap('delegate: pinningDelegate, ', '') }),
        /WebSocketService\.swift\.sessions/,
      )
    })
    test('desktop: the WebSocket connector is no longer the pinned one', () => {
      expectMoves(edited({ [DESKTOP_NET]: swap('connect_async_tls_with_config', 'connect_async') }), /net\.rs\.websocketConnects/)
    })
  })

  describe('the loopback exemption widened', () => {
    test('Android: "localhost" becomes a suffix match', () => {
      expectMoves(edited({ [ANDROID_API]: swap('hostname == "localhost"', 'hostname.endsWith("localhost")') }), /loopbackExemptions/)
    })
    test('Android relay: "localhost" becomes a suffix match', () => {
      expectMoves(edited({ [ANDROID_WS]: swap('host == "localhost"', 'host.endsWith(".localhost")') }), /loopbackExemptions/)
    })
    test('Android: an exemption written with no loopback literal at all is caught by the function digest', () => {
      expectMoves(
        edited({ [ANDROID_API]: swap(/val pinner = if \(isLocalhost\) CertificatePinner\.DEFAULT/, 'val pinner = if (isLocalhost || hostname.endsWith(".internal")) CertificatePinner.DEFAULT') }),
        /logic/,
      )
    })
    test('iOS: isLoopback accepts a host suffix', () => {
      expectMoves(
        edited({ [IOS_PINNING]: swap('case "localhost", "127.0.0.1", "::1", "[::1]": return true', 'case let h where h.hasSuffix("localhost"): return true') }),
        /loopbackExemptions|logic/,
      )
    })
    test('desktop: is_loopback_host accepts a domain suffix', () => {
      expectMoves(edited({ [DESKTOP_API_CONFIG]: swap('d.eq_ignore_ascii_case("localhost")', 'd.ends_with("localhost")') }), /loopbackExemptions|logic/)
    })
    test('desktop: the loopback http allowance made unconditional', () => {
      expectMoves(edited({ [DESKTOP_API_CONFIG]: swap('pub const ALLOW_LOOPBACK_HTTP: bool = cfg!(debug_assertions);', 'pub const ALLOW_LOOPBACK_HTTP: bool = true;') }), /ALLOW_LOOPBACK_HTTP|loopbackExemptions|logic/)
    })
  })

  describe('the enforcing logic weakened without touching a pin or a literal', () => {
    test('iOS: the chain is no longer evaluated before the pins are checked', () => {
      expectMoves(edited({ [IOS_PINNING]: swap('SecTrustEvaluateWithError(trust, nil)', 'true') }), /logic.*evaluate/)
    })
    test('desktop: the plausibility check accepts anything', () => {
      expectMoves(edited({ [DESKTOP_API_CONFIG]: swap('pin.len() == 44', 'pin.len() > 0') }), /is_plausible_spki_pin/)
    })
    test('desktop: the verifier accepts before looking at the pins', () => {
      expectMoves(
        edited({ [DESKTOP_CERT_PIN]: swap(/(fn verify_server_cert\([\s\S]*?\{)/, '$1 return Ok(ServerCertVerified::assertion());') }),
        /verify_server_cert/,
      )
    })
    test('Android: buildPinner stops adding the hashes', () => {
      expectMoves(edited({ [find('fun buildPinner')]: swap(/(fun buildPinner[\s\S]*?\{)/, '$1\n            return CertificatePinner.DEFAULT') }), /buildPinner/)
    })
  })

  // #3074 CodeQL js/incomplete-multi-character-sanitization: the XML reader used to strip comments,
  // then PIs, each as its own pass. A PI holding "<!--" paired with a later "-->" made the comment pass
  // eat the real markup between them — content an XML parser (aapt2, expat) reads and the snapshot never saw.
  describe('a weakening hidden in what the XML reader skips', () => {
    const SYSTEM_ANCHOR = '<certificates src="system" />'
    test('user CAs as trust anchors, concealed between a PI that opens "<!--" and one that closes it', () => {
      expectMoves(
        edited({ [NSC]: swap(SYSTEM_ANCHOR, `${SYSTEM_ANCHOR}<?x <!-- ?><certificates src="user" /><?y --> ?>`) }),
        /trustAnchors\[\]: "certificates:user"/,
      )
    })
    test('an extra pin in the <pin-set>, concealed the same way', () => {
      const pinSetOpen = '<pin-set expiration="2028-01-01">'
      expectMoves(
        edited({ [NSC]: swap(pinSetOpen, `${pinSetOpen}<?x <!-- ?><pin digest="SHA-256">${FLIP(X1)}</pin><?y --> ?>`) }),
        new RegExp(`pins\\.android\\.osPinSets\\[\\]: "${FLIP(X1).replace(/[+/]/g, '\\$&')}"`),
      )
    })
    test('a whole unpinned domain-config inside an unterminated-looking PI', () => {
      expectMoves(
        edited({ [NSC]: swap('</network-security-config>', '<?x <!-- ?><domain-config><domain>evil.example</domain></domain-config><?y --> ?></network-security-config>') }),
        /evil\.example/,
      )
    })
    test('a DTD internal subset whose entity expands to user CAs is refused, not read as an empty <trust-anchors>', () => {
      const tree = edited({
        [NSC]: (t) =>
          swap(SYSTEM_ANCHOR, `${SYSTEM_ANCHOR}&ua;`)(t).replace('<network-security-config>', '<!DOCTYPE network-security-config [ <!ENTITY ua \'<certificates src="user" />\'> ]>\n<network-security-config>'),
      })
      expect(() => extractTrustSnapshot(tree)).toThrow(/internal DTD subset/)
    })
    test('an unterminated comment, PI or CDATA section is refused', () => {
      for (const tail of ['<!-- never closed', '<?x never closed', '<![CDATA[ never closed']) {
        expect(() => extractTrustSnapshot(edited({ [NSC]: (t) => `${t}\n${tail}` }))).toThrow(TrustExtractionError)
      }
    })
    test('markup inside an attribute value is refused — the old reader stripped a "comment" that began inside one', () => {
      expect(() =>
        extractTrustSnapshot(edited({ [NSC]: swap('<domain-config>', '<domain-config x="<!--"><certificates src="user" /><y z="-->">') })),
      ).toThrow(TrustExtractionError)
    })
  })

  // #3074 CodeQL js/regex/missing-regexp-anchor flagged `java\.net\.Socket`. An unanchored SEARCH is right
  // for detection, so the anchor it asked for is not the fix — but the pattern was wrong: it matched only the
  // fully-qualified name, so a socket opened after `import java.net.*` was invisible, and its open end
  // counted `SocketTimeoutException` as the same API, so swapping one for the other moved nothing.
  describe('a transport opened in a form the API patterns used to miss', () => {
    const SOCK = 'apps/android/app/src/main/java/org/llamenos/hotline/api/Sock.kt'
    test('Android: a raw socket after a wildcard import', () => {
      expectMoves(edited({}, { [SOCK]: 'package x\nimport java.net.*\nfun f() = Socket("relay.example", 443)\n' }), /Sock\.kt.*Socket/)
    })
    test('Android: a socket factory after a wildcard import', () => {
      expectMoves(edited({}, { [SOCK]: 'package x\nimport javax.net.*\nfun f() = SocketFactory.getDefault().createSocket("relay.example", 443)\n' }), /Sock\.kt.*SocketFactory/)
    })
    test('Android: a socket swapped in for a lookalike identifier the old count lumped with it', () => {
      const before = extractTrustSnapshot(edited({}, { [SOCK]: 'package x\nfun f(e: Throwable) = e is java.net.SocketTimeoutException\n' }))
      const after = extractTrustSnapshot(edited({}, { [SOCK]: 'package x\nfun f() = java.net.Socket("relay.example", 443)\n' }))
      expect(diffSnapshots(before, after).join('\n')).toMatch(/Sock\.kt\.other\.Socket\b/)
    })
    test('iOS: a second trust-evaluation call of a different name is counted under its own name', () => {
      const before = extractTrustSnapshot(edited({ [IOS_PINNING]: (t) => `${t}\nfunc a(_ t: SecTrust) { _ = SecTrustCopyKey(t) }\n` }))
      const after = extractTrustSnapshot(edited({ [IOS_PINNING]: (t) => `${t}\nfunc a(_ t: SecTrust) { _ = SecTrustSetExceptions(t, nil) }\n` }))
      expect(diffSnapshots(before, after).join('\n')).toMatch(/SecTrustSetExceptions/)
    })
  })

  test('the walker reads a pin hidden in a comment as no pin at all', () => {
    // A commented-out pin is not a pin: adding one must not move the snapshot, and removing the real one must.
    expectUnchanged(edited({ [IOS_PINNING]: (t) => `${t}\n// static let isrgRootBogus = "${FLIP(X1)}"\n` }))
  })
})

// ---------------------------------------------------------------------------
// 3. No noise
// ---------------------------------------------------------------------------

describe('no noise — diffs that change no trust decision leave the snapshot alone', () => {
  test('#3051: five imports and three suspend wrappers on existing routes in the Android HTTP surface', () => {
    expectUnchanged(
      edited({
        [ANDROID_API]: (t) =>
          t
            .replace('import okhttp3.OkHttpClient', 'import okhttp3.OkHttpClient\nimport org.llamenos.hotline.model.Alpha\nimport org.llamenos.hotline.model.Beta')
            .replace(/\}\s*$/, '\n    suspend fun alpha(): Alpha = get("/api/alpha")\n    suspend fun beta(id: String): Beta = get("/api/beta/$id")\n    suspend fun gamma(): Unit = post("/api/gamma")\n}\n'),
      }),
    )
  })
  test('#3060: a non-exported activity added to the manifest', () => {
    expectUnchanged(edited({ [MANIFEST]: swap('</application>', '    <activity android:name=".NotificationTapActivity" android:exported="false" />\n    </application>') }))
  })
  test('a new intent filter / deep link / permission in the manifest', () => {
    expectUnchanged(
      edited({
        [MANIFEST]: swap('<uses-permission android:name="android.permission.VIBRATE" />', '<uses-permission android:name="android.permission.VIBRATE" />\n    <uses-permission android:name="android.permission.NFC" />'),
      }),
    )
  })
  test('a source entry added to project.yml — one Swift file added to the iOS app must not demand a TLS signature', () => {
    expectUnchanged(
      edited({
        [PROJECT_YML]: (t) => {
          const doc = parseDocument(t)
          doc.addIn(['targets', 'Llamenos', 'sources'], { path: 'Sources/NewFeature' })
          return stringify(doc.toJS())
        },
      }, { 'apps/ios/Sources/NewFeature/Thing.swift': 'import Foundation\nstruct Thing { let id: Int }\n' }),
    )
  })
  test('a new Swift file with no networking', () => {
    expectUnchanged(edited({}, { 'apps/ios/Sources/Views/Thing.swift': 'import SwiftUI\nstruct Thing: View { var body: some View { Text("x") } }\n' }))
  })
  test("knope's version bump in Info.plist", () => {
    expectUnchanged(edited({ [INFO_PLIST]: swap(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*/, '$19.9.9') }))
  })
  test('an unrelated function added to net.rs and api_config.rs', () => {
    expectUnchanged(
      edited({
        [DESKTOP_NET]: (t) => `${t}\npub fn unrelated_helper() -> u8 { 1 }\n`,
        [DESKTOP_API_CONFIG]: (t) => `${t}\npub fn another_helper(s: &str) -> usize { s.len() }\n`,
      }),
    )
  })
  test('a test-only unpinned client in desktop code', () => {
    expectUnchanged(
      edited({ [DESKTOP_NET]: (t) => `${t}\n#[cfg(test)]\nmod more_tests {\n    #[test]\n    fn c() { let _ = reqwest::Client::new(); }\n}\n` }),
    )
  })
  test('unpinned clients in Android test source sets, which do not ship', () => {
    expectUnchanged(
      edited({}, {
        'apps/android/app/src/test/java/x/FakeServer.kt': 'val c = OkHttpClient.Builder().build()\n',
        'apps/android/app/src/androidTest/java/x/Fake.kt': 'val c = HttpURLConnection\n',
        'apps/android/app/src/debug/res/xml/network_security_config.xml': '<network-security-config><base-config cleartextTrafficPermitted="true"/></network-security-config>',
      }),
    )
  })
  test('reordering the pins in every place they are listed', () => {
    const reverseLines = (re: RegExp) => (t: string): string => {
      const m = re.exec(t)
      if (m === null) throw new Error(`no match for ${String(re)}`)
      return t.replace(m[0], m[0].split('\n').reverse().join('\n'))
    }
    expectUnchanged(
      edited({
        [NSC]: reverseLines(/(?:[ ]*<!-- ISRG[^\n]*-->\n[ ]*<pin[^\n]*<\/pin>\n?){4}/),
        [ANDROID_PIN_FILE]: swap(/ISRG_ROOT_X1_HASH,\n(\s*)ISRG_ROOT_X2_HASH,/, 'ISRG_ROOT_X2_HASH,\n$1ISRG_ROOT_X1_HASH,'),
        [IOS_PINNING]: swap('[isrgRootX1Hash, isrgRootX2Hash,', '[isrgRootX2Hash, isrgRootX1Hash,'),
      }),
    )
  })
  test('comments and docs: a comment that mentions localhost, a pin and cleartextTrafficPermitted', () => {
    expectUnchanged(
      edited({
        [ANDROID_API]: (t) => `// host == "localhost" skips pinning; sha256/${FLIP(derived.android.x1)}\n${t}`,
        [DESKTOP_NET]: (t) => `/// is_loopback_host("localhost") and LOCALHOST\n${t}`,
        [IOS_PINNING]: (t) => `/* "127.0.0.1" ${FLIP(derived.ios.x2)} */\n${t}`,
      }),
    )
  })
  test('a pinned client replaced by itself: formatting-only edits', () => {
    expectUnchanged(edited({ [ANDROID_API]: (t) => t.replace('OkHttpClient.Builder()', 'OkHttpClient\n            .Builder()') }))
  })
})

// ---------------------------------------------------------------------------
// 4. Fail closed
// ---------------------------------------------------------------------------

describe('a tree the extractor cannot read is refused, never read as "nothing changed"', () => {
  test('DEFAULT_PIN_HASHES renamed away', () => {
    expect(() => extractTrustSnapshot(edited({ [ANDROID_PIN_FILE]: swap('DEFAULT_PIN_HASHES', 'PIN_HASHES') }))).toThrow(TrustExtractionError)
  })
  test('DEFAULT_PIN_HASHES naming something that is not a pin', () => {
    expect(() => extractTrustSnapshot(edited({ [ANDROID_PIN_FILE]: swap('ISRG_ROOT_X1_HASH,\n', 'computePins(),\n') }))).toThrow(/not a pin constant/)
  })
  test('the iOS pin set gone', () => {
    expect(() => extractTrustSnapshot(edited({ [IOS_PINNING]: swap(/static let pinned/, 'static let pinnedSet') }))).toThrow(TrustExtractionError)
  })
  test('the desktop pin table gone', () => {
    expect(() => extractTrustSnapshot(edited({ [DESKTOP_CERT_PIN]: swap('ISRG_ROOT_PINS: [&str; 4]', 'ROOT_PINS: [&str; 4]') }))).toThrow(TrustExtractionError)
  })
  test('the Android network security config deleted', () => {
    const tree: TreeReader = { list: (p) => real.list(p).filter((f) => f !== NSC), read: (p) => (p === NSC ? undefined : real.read(p)) }
    expect(() => extractTrustSnapshot(tree)).toThrow(/network security config/)
  })
  test('malformed XML in the manifest', () => {
    expect(() => extractTrustSnapshot(edited({ [MANIFEST]: swap('</manifest>', '') }))).toThrow(TrustExtractionError)
  })
  test('shipped source in a language the extractor does not scan — a client could hide in it', () => {
    expect(() => extractTrustSnapshot(edited({}, { 'apps/android/app/src/main/java/x/Hidden.java': 'class Hidden {}' }))).toThrow(/does not scan/)
    expect(() => extractTrustSnapshot(edited({}, { 'apps/ios/Sources/Services/Hidden.m': '@implementation X @end' }))).toThrow(/does not scan/)
    // …but the same file in a source set that does not ship is not a refusal.
    expect(() => extractTrustSnapshot(edited({}, { 'apps/android/app/src/test/java/x/Fixture.java': 'class Fixture {}' }))).not.toThrow()
  })
  test('a cfg(test) item whose end cannot be found is refused, not truncated to the end of the file', () => {
    expect(() => extractTrustSnapshot(edited({ [DESKTOP_NET]: (t) => `${t}\n#[cfg(test)]\nfn broken( {\n` }))).toThrow(TrustExtractionError)
  })
  test('a "#[cfg(test)]" inside a string literal does not remove the code after it', () => {
    const out = stripRustTests('const S: &str = "#[cfg(test)]";\nfn shipped() { let _ = reqwest::Client::new(); }\n')
    expect(out).toContain('fn shipped()')
  })
  test('a malformed project spec', () => {
    expect(() => extractTrustSnapshot(edited({ [PROJECT_YML]: (t) => `${t}\n  : : [` }))).toThrow(TrustExtractionError)
  })
})

// ---------------------------------------------------------------------------
// 5. The release boundary
// ---------------------------------------------------------------------------

describe('the release boundary', () => {
  const widened = extractTrustSnapshot(edited({ [MANIFEST]: swap('<application', '<application android:usesCleartextTraffic="true"') }))
  const signedBy = 'rhonda-rodododo'
  const entry = (s: TrustSnapshot, who = signedBy) => ({ digest: snapshotDigest(s), signedBy: who, signedAt: '2026-11-26T00:00:00Z' })

  test('an unchanged snapshot needs no sign-off at all', () => {
    const v = releaseVerdict({ baseline, candidate: baseline, signoffs: [] })
    expect(v.ok).toBe(true)
    expect(v.changed).toBe(false)
    expect(v.diff).toEqual([])
  })
  test('a changed snapshot with no sign-off is refused, shows what changed and names the digest to sign', () => {
    const v = releaseVerdict({ baseline, candidate: widened, signoffs: [] })
    expect(v.ok).toBe(false)
    expect(v.diff.join('\n')).toMatch(/usesCleartextTraffic/)
    expect(v.reason).toContain(snapshotDigest(widened))
  })
  test('a sign-off naming the new digest lets it ship', () => {
    const v = releaseVerdict({ baseline, candidate: widened, signoffs: [entry(widened)] })
    expect(v.ok).toBe(true)
    expect(v.changed).toBe(true)
  })
  test('a sign-off for an EARLIER snapshot does not carry over to a later change', () => {
    const later = extractTrustSnapshot(
      edited({ [MANIFEST]: swap('<application', '<application android:usesCleartextTraffic="true"'), [NSC]: swap('cleartextTrafficPermitted="false"', 'cleartextTrafficPermitted="true"') }),
    )
    expect(releaseVerdict({ baseline, candidate: later, signoffs: [entry(widened)] }).ok).toBe(false)
  })
  test('a sign-off by someone who is not an approver does not count', () => {
    expect(releaseVerdict({ baseline, candidate: widened, signoffs: [entry(widened, 'llamenos-auto')] }).ok).toBe(false)
    expect(releaseVerdict({ baseline, candidate: widened, signoffs: [entry(widened, '')] }).ok).toBe(false)
  })
  test('the very first release (no baseline) needs a sign-off too', () => {
    expect(releaseVerdict({ baseline: undefined, candidate: baseline, signoffs: [] }).ok).toBe(false)
    expect(releaseVerdict({ baseline: undefined, candidate: baseline, signoffs: [entry(baseline)] }).ok).toBe(true)
  })
  test('a malformed ledger is an error, not "no sign-offs"', () => {
    expect(() => readSignoffs({})).toThrow(TrustExtractionError)
    expect(() => readSignoffs({ signoffs: [{ digest: 'abc', signedBy, signedAt: '2026-01-01' }] })).toThrow(/malformed/)
    expect(() => readSignoffs({ signoffs: [{ digest: 'a'.repeat(64), signedBy, signedAt: 'yesterday' }] })).toThrow(/malformed/)
  })
  test('the committed ledger parses', () => {
    expect(readSignoffs(JSON.parse(readFileSync(join(ROOT, SIGNOFF_LEDGER_PATH), 'utf8')))).toBeArray()
  })
  test('the approvers match the orchestrator\'s', async () => {
    const { TRUST_ANCHOR_APPROVERS } = await import('../../../orchestrator/src/config.js')
    const { TRUST_SIGNOFF_APPROVERS } = await import('./trust-snapshot')
    expect([...TRUST_SIGNOFF_APPROVERS]).toEqual([...TRUST_ANCHOR_APPROVERS])
  })
})

// ---------------------------------------------------------------------------
// 6. The helpers the extractor stands on
// ---------------------------------------------------------------------------

describe('helpers', () => {
  test('stripComments keeps a // inside a string and drops a real comment', () => {
    expect(stripComments('val u = "https://a/b" // "localhost"\n/* "x" */val y = 1', 'kotlin')).toBe('val u = "https://a/b" \nval y = 1')
  })
  test("stripComments survives a char literal holding a quote", () => {
    expect(stripComments(`let c = '"'; // gone\nlet d = 1;`, 'rust')).toBe(`let c = '"'; \nlet d = 1;`)
  })
  test('stripRustTests removes cfg(test) items and nothing else', () => {
    const out = stripRustTests('fn a() {}\n#[cfg(test)]\nmod t { fn b() { reqwest::Client::new(); } }\nfn c() {}\n#[cfg(test)]\nuse x::y;\nfn d() {}')
    expect(out).toContain('fn a()')
    expect(out).toContain('fn c()')
    expect(out).toContain('fn d()')
    expect(out).not.toContain('Client::new')
    expect(out).not.toContain('use x::y')
  })
  test('functionBodies finds block and expression bodies and every overload', () => {
    expect(functionBodies('fun hostOf(u: String): String? { return URI(u).host }', 'hostOf', 'kotlin')).toEqual(['(u: String): String? { return URI(u).host }'])
    expect(functionBodies('fun hostOf(u: String) = URI(u).host\nfun other() {}', 'hostOf', 'kotlin')).toEqual(['(u: String) = URI(u).host'])
    expect(functionBodies('fn f(a: u8) -> u8 { a }\nfn f(a: u16) -> u16 { a }', 'f', 'rust')).toHaveLength(2)
  })
  test('parseXml reads attributes, nesting and self-closing tags; parsePlist reads dicts', () => {
    const x = parseXml('<a x="1"><b y=\'2\'/><c>t</c></a>')
    expect(x.children[0]?.children.map((c) => c.tag)).toEqual(['b', 'c'])
    // Comments, PIs and an external DOCTYPE are skipped as XML defines them; CDATA and entities are text.
    const y = parseXml('<?xml version="1.0"?><!DOCTYPE a PUBLIC "-//X//EN" "x.dtd"><a><!-- <b/> --><?p <c/> ?><d>&lt;&#x41;&amp;<![CDATA[<e/>]]></d></a>')
    expect(y.children[0]?.children.map((c) => c.tag)).toEqual(['d'])
    expect(y.children[0]?.children[0]?.text).toBe('<A&<e/>')
    expect(() => parseXml('<a>&bogus;</a>')).toThrow(/entity/)
    expect(() => parseXml('<a><!-- a -- b --></a>')).toThrow(/comment/)
    expect(() => parseXml('<a x="1" x="2"/>')).toThrow(/duplicate/)
    expect(parsePlist('<plist><dict><key>K</key><dict><key>B</key><false/></dict></dict></plist>')).toEqual({ K: { B: false } })
  })
  test('diffSnapshots treats arrays of scalars as sets', () => {
    expect(diffSnapshots({ a: ['x', 'y'] }, { a: ['y', 'x'] })).toEqual([])
    expect(diffSnapshots({ a: ['x'] }, { a: ['x', 'z'] })).toEqual(['+ a[]: "z"'])
    expect(diffSnapshots({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(['~ a.b: 1 → 2'])
  })
})
