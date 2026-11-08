import { describe, it, expect } from 'vitest'
import { buildGateTrace } from '../../orchestrator/src/trace.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

const passingReport = (): VerifyReport => ({
  passed: true, reasons: [], changedFiles: ['apps/ios/a.swift'], addedLines: 3,
  impact: 'low', impactReasons: [], testsRun: ['orchestrator'], testsPassed: true, verifiedCommit: 'c0ffee',
})

describe('buildGateTrace', () => {
  it('reports every stage as not-run when nothing ran at all', () => {
    expect(buildGateTrace({})).toBe('scope=not-run impact=not-run tests=not-run review=not-run sha=none')
  })

  it('reports a fully-passing run', () => {
    const trace = buildGateTrace({ report: passingReport(), reviewVerdict: 'PASS' })
    expect(trace).toBe('scope=pass impact=low tests=orchestrator:pass review=PASS sha=c0ffee')
  })

  it('reports scope failure distinctly from a test failure', () => {
    const scopeFailed: VerifyReport = {
      ...passingReport(), passed: false, testsRun: undefined, testsPassed: undefined,
      reasons: ['touched never-write paths: .env'],
    }
    expect(buildGateTrace({ report: scopeFailed })).toContain('scope=fail(touched never-write paths: .env)')
    expect(buildGateTrace({ report: scopeFailed })).toContain('tests=none')
  })

  // #2556: an unapproved trust-anchor change is a scope-stage refusal too —
  // it must never read as "scope=pass" in the ledger.
  it('reports an unapproved trust-anchor change as a scope failure', () => {
    const held: VerifyReport = {
      ...passingReport(), passed: false, testsRun: undefined, testsPassed: undefined,
      reasons: ["touched trust-anchor files — a shipped client's TLS trust decision, which lands only with a human sign-off: x"],
    }
    expect(buildGateTrace({ report: held })).toContain('scope=fail(touched trust-anchor files — ')
  })

  it('reports a test failure with scope passing', () => {
    const testsFailed: VerifyReport = {
      ...passingReport(), passed: false, testsPassed: false, reasons: ['diff-targeted tests failed'],
    }
    const trace = buildGateTrace({ report: testsFailed })
    expect(trace).toContain('scope=pass')
    expect(trace).toContain('tests=orchestrator:fail')
  })

  it('reports an unproven test run distinctly from a real failure', () => {
    const unproven: VerifyReport = { ...passingReport(), testsPassed: undefined }
    expect(buildGateTrace({ report: unproven })).toContain('tests=orchestrator:unproven')
  })

  it('reports an infrastructure failure (no changed files, no scope check reached) as unknown', () => {
    const infra: VerifyReport = {
      passed: false, reasons: ['could not resolve HEAD in /wt — git rev-parse failed'],
      changedFiles: [], addedLines: 0, impact: 'low', impactReasons: [],
    }
    expect(buildGateTrace({ report: infra })).toContain('scope=unknown(could not resolve HEAD in /wt — git rev-parse failed)')
  })

  it('reports high impact with its first reason', () => {
    const highImpact: VerifyReport = { ...passingReport(), impact: 'high', impactReasons: ['deploy/x.yaml is under high-impact path deploy/', 'second reason'] }
    expect(buildGateTrace({ report: highImpact })).toContain('impact=high(deploy/x.yaml is under high-impact path deploy/)')
  })

  it('reports UNREADABLE with a truncated reason, distinct from FAIL', () => {
    const trace = buildGateTrace({ report: passingReport(), reviewVerdict: 'UNREADABLE', reviewText: '(reviewer engine was unreachable)' })
    expect(trace).toContain('review=UNREADABLE((reviewer engine was unreachable))')
  })

  it('reports review as not-run when mechanical verification never passed', () => {
    const failing: VerifyReport = { ...passingReport(), passed: false, reasons: ['touched never-write paths: .env'] }
    expect(buildGateTrace({ report: failing })).toContain('review=not-run')
  })

  // The trace is the ONLY record of what the fleet itself checked, and it
  // deliberately no longer carries a merge verdict: whether a PR merged is a
  // fact about GitHub, derived live, never cached here.
  it('carries no merge field at all — merging is not this process\'s decision to record', () => {
    expect(buildGateTrace({ report: passingReport(), reviewVerdict: 'PASS' })).not.toContain('merge=')
  })

  // MUTATION GUARD: every value is an explicit string, never absent — a
  // regression that dropped a key silently (e.g. `undefined` interpolated
  // into the template, or a key omitted for the not-run case) is caught by
  // asserting every one of the five keys is always present.
  it('always emits all five keys, whatever the input', () => {
    for (const input of [{}, { report: passingReport() }, { reviewVerdict: 'FAIL' as const }]) {
      const trace = buildGateTrace(input)
      for (const key of ['scope=', 'impact=', 'tests=', 'review=', 'sha=']) {
        expect(trace).toContain(key)
      }
    }
  })
})
