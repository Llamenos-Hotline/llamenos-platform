/**
 * Guards the injection points of scripts/inject-cert-pins.ts (#1096).
 *
 * The defect these tests exist for: the script's Android matcher targeted a
 * `CertificatePinner.Builder()` block that no longer exists in ApiService.kt, so
 * cert-pin injection for Android was silently unusable. A build-time script whose
 * matcher stops matching is how pinning quietly disappears — every platform
 * injection point is exercised here against the shipped sources, so a refactor
 * that moves the pins fails this suite, not the next manual run.
 *
 *   bun test scripts/inject-cert-pins.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  derivePinFromPem,
  isValidPin,
  PIN_TARGETS,
  planInjection,
  ROOT,
  ROOT_KEYS,
  type RootKey,
} from "./inject-cert-pins";

const SENTINEL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const readTarget = (file: string): string => readFileSync(file, "utf-8");

describe("injection points match the shipped sources", () => {
  for (const target of PIN_TARGETS) {
    describe(target.file.replace(`${ROOT}/`, ""), () => {
      const content = readTarget(target.file);
      for (const key of ROOT_KEYS) {
        test(`${key} (${target.platform})`, () => {
          const current = target.extract(content, key);
          expect(isValidPin(current)).toBe(true);
          const updated = target.inject(content, key, SENTINEL);
          expect(updated).not.toBe(content);
          expect(target.extract(updated, key)).toBe(SENTINEL);
          // Injecting back the shipped value restores the file byte-for-byte.
          expect(target.inject(updated, key, current)).toBe(content);
        });
      }
    });
  }

  test("every platform enforcement point is covered", () => {
    const files = new Set(PIN_TARGETS.map((t) => t.file));
    expect([...files].sort()).toEqual([
      resolve(ROOT, "apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt"),
      resolve(ROOT, "apps/android/app/src/main/res/xml/network_security_config.xml"),
      resolve(ROOT, "apps/desktop/src/cert_pin.rs"),
      resolve(ROOT, "apps/ios/Sources/Services/CertificatePinning.swift"),
    ]);
  });
});

describe("injector failure modes", () => {
  const target = PIN_TARGETS[0];

  test("a missing anchor throws instead of writing", () => {
    expect(() => target.inject("const val SOMETHING_ELSE = 1\n", "x1", SENTINEL)).toThrow(
      /could not find the ISRG Root X1 pin/,
    );
  });

  test("an ambiguous anchor throws instead of guessing", () => {
    const doubled = readTarget(target.file) + "\n" + readTarget(target.file);
    expect(() => target.inject(doubled, "x1", SENTINEL)).toThrow(/matched 2 places/);
  });
});

describe("planInjection is all-or-nothing and idempotent", () => {
  test("planning with the currently shipped pins changes nothing", async () => {
    const kotlin = readTarget(PIN_TARGETS[0].file);
    const pins = Object.fromEntries(
      ROOT_KEYS.map((key) => [key, PIN_TARGETS[0].extract(kotlin, key)]),
    ) as Record<RootKey, string>;
    const plans = await planInjection(pins);
    expect(plans.map((p) => p.updated)).toEqual(PIN_TARGETS.map(() => null));
  });

  test("an invalid pin is rejected", async () => {
    await expect(planInjection({ x1: "not-a-pin" })).rejects.toThrow(/invalid pin/);
  });
});

describe("derivePinFromPem", () => {
  // The fixtures every platform's own pin-derivation test re-derives from.
  const FIXTURES: Record<RootKey, string> = {
    x1: "apps/android/app/src/test/resources/certs/isrg-root-x1.pem",
    x2: "apps/android/app/src/test/resources/certs/isrg-root-x2.pem",
    yr: "apps/android/app/src/test/resources/certs/isrg-root-yr.pem",
    ye: "apps/android/app/src/test/resources/certs/isrg-root-ye.pem",
  };

  for (const key of ROOT_KEYS) {
    test(`${key}: the published root derives to the pin every platform ships`, async () => {
      const pem = readTarget(resolve(ROOT, FIXTURES[key]));
      const pin = await derivePinFromPem(pem);
      expect(isValidPin(pin)).toBe(true);
      for (const target of PIN_TARGETS) {
        expect(target.extract(readTarget(target.file), key)).toBe(pin);
      }
    });
  }

  test("rejects input that is not a PEM certificate", async () => {
    await expect(derivePinFromPem("not a certificate")).rejects.toThrow(/PEM certificate/);
  });
});
