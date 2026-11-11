#!/usr/bin/env bun
/**
 * Inject Let's Encrypt root-CA SPKI pins into every platform's compiled-in pin set.
 *
 * The shipped pin set is the four ISRG roots (X1, X2, YR, YE) — never a leaf or an
 * intermediate — so routine certificate renewal never breaks a client. This script
 * re-derives a root's pin (base64 SHA-256 of the DER SubjectPublicKeyInfo, RFC 7469)
 * from its published PEM certificate and rewrites the pinned hash literal at all
 * four enforcement points:
 *
 *   apps/android/.../api/ApiService.kt                ISRG_ROOT_{X1,X2,YR,YE}_HASH ("sha256/…" form)
 *   apps/android/.../res/xml/network_security_config.xml  <pin digest="SHA-256">…</pin>
 *   apps/ios/Sources/Services/CertificatePinning.swift    CertificatePins.isrgRoot*Hash
 *   apps/desktop/src/cert_pin.rs                        ISRG_ROOT_PINS
 *
 * Usage:
 *   bun scripts/inject-cert-pins.ts --all                 # fetch the four published ISRG PEMs
 *   bun scripts/inject-cert-pins.ts x1=./isrgrootx1.pem [x2=…] [yr=…] [ye=…]
 *   bun scripts/inject-cert-pins.ts yr=https://letsencrypt.org/certs/gen-y/root-yr.pem
 *
 * A source is a local PEM path or an https:// URL. Only the named roots are touched,
 * so a single rotating root can be updated without re-fetching the others.
 *
 * The script is idempotent and all-or-nothing: every injection point is located
 * BEFORE any file is written, and if one has moved (a platform refactor changed the
 * shape of its pin constant) nothing is written and the script exits 1. That failure
 * is the guard against pinning quietly disappearing — scripts/inject-cert-pins.test.ts
 * exercises every injection point against the shipped sources so a refactor that moves
 * them fails the test suite, not just the next manual run.
 *
 * To inspect the chain a live deployment serves (leaf + intermediate — these are NOT
 * the shipped pin values, see docs/security/CERTIFICATE_PINS.md), use
 * scripts/extract-cert-pins.sh (`bun run cert-pins:extract`).
 */

import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Root slots
// ---------------------------------------------------------------------------

export type RootKey = "x1" | "x2" | "yr" | "ye";
export const ROOT_KEYS: readonly RootKey[] = ["x1", "x2", "yr", "ye"];

const ROOT_LABEL: Record<RootKey, string> = {
  x1: "ISRG Root X1",
  x2: "ISRG Root X2",
  yr: "ISRG Root YR",
  ye: "ISRG Root YE",
};

/** The PEMs Let's Encrypt publishes for each root (docs/security/CERTIFICATE_PINS.md). */
const PUBLISHED_PEM_URL: Record<RootKey, string> = {
  x1: "https://letsencrypt.org/certs/isrgrootx1.pem",
  x2: "https://letsencrypt.org/certs/isrg-root-x2.pem",
  yr: "https://letsencrypt.org/certs/gen-y/root-yr.pem",
  ye: "https://letsencrypt.org/certs/gen-y/root-ye.pem",
};

const KOTLIN_CONST: Record<RootKey, string> = {
  x1: "ISRG_ROOT_X1_HASH",
  x2: "ISRG_ROOT_X2_HASH",
  yr: "ISRG_ROOT_YR_HASH",
  ye: "ISRG_ROOT_YE_HASH",
};

const SWIFT_CONST: Record<RootKey, string> = {
  x1: "isrgRootX1Hash",
  x2: "isrgRootX2Hash",
  yr: "isrgRootYRHash",
  ye: "isrgRootYEHash",
};

/** base64(SHA-256(..)) is exactly 44 chars: 43 from the alphabet plus one '=' pad. */
const HASH_PATTERN = "[A-Za-z0-9+/]{43}=";
const HASH_RE = new RegExp(`^${HASH_PATTERN}$`);

export function isValidPin(hash: string): boolean {
  return HASH_RE.test(hash);
}

export class InjectionPointNotFoundError extends Error {
  constructor(
    public readonly platform: string,
    public readonly file: string,
    public readonly key: RootKey,
  ) {
    super(
      `${platform}: could not find the ${ROOT_LABEL[key]} pin in ${file} — ` +
        "the source shape changed; update the matcher in scripts/inject-cert-pins.ts",
    );
    this.name = "InjectionPointNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Injection points — one per platform file, anchored on the per-root constant
// name (Kotlin/Swift) or the per-root comment that precedes the hash (XML/Rust).
// ---------------------------------------------------------------------------

export interface PinTarget {
  platform: string;
  /** Absolute path of the shipped source file this target rewrites. */
  file: string;
  /**
   * Return `content` with the pin for `key` replaced by `hash`.
   * Throws InjectionPointNotFoundError when the anchor is absent or ambiguous.
   */
  inject(content: string, key: RootKey, hash: string): string;
  /** The pin literal currently present for `key`; same failure mode as inject. */
  extract(content: string, key: RootKey): string;
}

/**
 * Build an injector from a per-key regex with exactly three capture groups:
 * (prefix)(old hash)(suffix). The match must be unique — a pattern that hits two
 * places would silently pin two slots to one root.
 */
function regexInjector(
  platform: string,
  file: string,
  patternFor: (key: RootKey) => RegExp,
): PinTarget {
  const locate = (content: string, key: RootKey): RegExpMatchArray => {
    const pattern = patternFor(key);
    const matches = content.match(new RegExp(pattern.source, `g${pattern.flags.includes("s") ? "s" : ""}`));
    if (!matches || matches.length === 0) {
      throw new InjectionPointNotFoundError(platform, file, key);
    }
    if (matches.length > 1) {
      throw new Error(
        `${platform}: the ${ROOT_LABEL[key]} pin pattern matched ${matches.length} places in ${file} — refusing to guess`,
      );
    }
    const match = content.match(pattern);
    if (!match) throw new InjectionPointNotFoundError(platform, file, key);
    return match;
  };
  return {
    platform,
    file,
    inject(content, key, hash) {
      locate(content, key);
      return content.replace(patternFor(key), `$1${hash}$3`);
    },
    extract(content, key) {
      return locate(content, key)[2];
    },
  };
}

export const PIN_TARGETS: readonly PinTarget[] = [
  // Android OkHttp pinner — `const val ISRG_ROOT_X1_HASH = "sha256/…"`.
  regexInjector(
    "android",
    resolve(ROOT, "apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt"),
    (key) => new RegExp(`(const val ${KOTLIN_CONST[key]} = "sha256/)(${HASH_PATTERN})(")`),
  ),
  // Android OS-level pin set — `<!-- ISRG Root X1 — … -->\n<pin digest="SHA-256">…</pin>`.
  regexInjector(
    "android",
    resolve(ROOT, "apps/android/app/src/main/res/xml/network_security_config.xml"),
    (key) =>
      new RegExp(
        `(<!-- ${ROOT_LABEL[key]}[^\\n]*-->\\s*<pin digest="SHA-256">)(${HASH_PATTERN})(</pin>)`,
      ),
  ),
  // iOS — `static let isrgRootX1Hash = "…"` (no "sha256/" prefix in this file).
  regexInjector(
    "ios",
    resolve(ROOT, "apps/ios/Sources/Services/CertificatePinning.swift"),
    (key) => new RegExp(`(static let ${SWIFT_CONST[key]} = ")(${HASH_PATTERN})(")`),
  ),
  // Desktop — inside `const ISRG_ROOT_PINS`, each hash follows its `// ISRG Root …` comment.
  regexInjector(
    "desktop",
    resolve(ROOT, "apps/desktop/src/cert_pin.rs"),
    (key) => new RegExp(`(// ${ROOT_LABEL[key]}[^\\n]*\\n\\s*")(${HASH_PATTERN})(")`),
  ),
];

// ---------------------------------------------------------------------------
// Pin derivation: PEM certificate → base64 SHA-256 SPKI pin, via openssl
// (the same pipeline every platform's derivation test documents).
// ---------------------------------------------------------------------------

export async function derivePinFromPem(pem: string): Promise<string> {
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("source does not contain a PEM certificate block");
  }
  const dir = mkdtempSync(join(tmpdir(), "inject-cert-pins-"));
  const pemPath = join(dir, "cert.pem");
  writeFileSync(pemPath, pem);
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      "openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64",
    ],
    { stdin: Bun.file(pemPath), stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const pin = stdout.trim();
  if (exitCode !== 0 || !isValidPin(pin)) {
    throw new Error(`openssl failed to derive a pin from the certificate: ${stderr.trim()}`);
  }
  return pin;
}

async function loadPem(source: string): Promise<string> {
  if (source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`failed to fetch ${source}: HTTP ${res.status}`);
    }
    return res.text();
  }
  return readFile(resolve(source), "utf-8");
}

// ---------------------------------------------------------------------------
// Injection — all-or-nothing across every platform file.
// ---------------------------------------------------------------------------

export interface InjectionPlan {
  target: PinTarget;
  /** The new file contents, or null when the pins already match (idempotent no-op). */
  updated: string | null;
}

/**
 * Compute the new contents of every platform file for the given pins without
 * writing anything. Throws on the first missing injection point, so a partial
 * pin set can never be written.
 */
export async function planInjection(pins: Partial<Record<RootKey, string>>): Promise<InjectionPlan[]> {
  const keys = ROOT_KEYS.filter((k) => pins[k] !== undefined);
  if (keys.length === 0) {
    throw new Error("no pins given");
  }
  const plans: InjectionPlan[] = [];
  for (const target of PIN_TARGETS) {
    const original = await readFile(target.file, "utf-8");
    let updated = original;
    for (const key of keys) {
      const hash = pins[key];
      if (!hash || !isValidPin(hash)) {
        throw new Error(`invalid pin for ${ROOT_LABEL[key]}: ${JSON.stringify(hash)}`);
      }
      updated = target.inject(updated, key, hash);
    }
    plans.push({ target, updated: updated === original ? null : updated });
  }
  return plans;
}

export async function applyInjection(plans: InjectionPlan[]): Promise<void> {
  for (const { target, updated } of plans) {
    if (updated === null) {
      console.log(`${target.platform}: ${target.file} already up to date`);
    } else {
      await writeFile(target.file, updated);
      console.log(`${target.platform}: updated ${target.file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.error("Usage:");
  console.error("  bun scripts/inject-cert-pins.ts --all");
  console.error("  bun scripts/inject-cert-pins.ts <x1|x2|yr|ye>=<pem-path-or-https-url> [...]");
  console.error("Example: bun scripts/inject-cert-pins.ts x1=./isrgrootx1.pem");
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) usage();

  const sources: Partial<Record<RootKey, string>> = {};
  for (const arg of argv) {
    if (arg === "--all") {
      for (const key of ROOT_KEYS) sources[key] = PUBLISHED_PEM_URL[key];
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(0, eq) as RootKey;
    const source = arg.slice(eq + 1);
    if (eq <= 0 || !ROOT_KEYS.includes(key) || !source) usage();
    sources[key] = source;
  }

  const pins: Partial<Record<RootKey, string>> = {};
  for (const key of ROOT_KEYS) {
    const source = sources[key];
    if (!source) continue;
    console.log(`Deriving ${ROOT_LABEL[key]} pin from ${source} ...`);
    pins[key] = await derivePinFromPem(await loadPem(source));
    console.log(`  ${ROOT_LABEL[key]}: sha256/${pins[key]}`);
  }

  const plans = await planInjection(pins);
  await applyInjection(plans);

  console.log();
  console.log("Certificate pins injected. Next steps:");
  console.log("  1. Review the diffs: git diff apps/android apps/ios apps/desktop");
  console.log("  2. Run each platform's pin-derivation test (they re-derive every hash");
  console.log("     from the real certificates and must keep passing)");
  console.log("  3. Update docs/security/CERTIFICATE_PINS.md if the pin set changed");
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
