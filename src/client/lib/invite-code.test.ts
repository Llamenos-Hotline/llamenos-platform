import { describe, expect, it } from 'vitest'
import { INVITE_CODE_LENGTH, normalizeInviteCode } from './invite-code'

const CODE = '3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c'

describe('normalizeInviteCode', () => {
  it('accepts a code exactly as the server issues it', () => {
    expect(normalizeInviteCode(CODE)).toBe(CODE)
    expect(CODE).toHaveLength(INVITE_CODE_LENGTH)
  })

  it('trims surrounding whitespace and line breaks from a Signal/clipboard round trip', () => {
    expect(normalizeInviteCode(`  ${CODE}\n`)).toBe(CODE)
    expect(normalizeInviteCode(`\r\n\t${CODE}\r\n`)).toBe(CODE)
  })

  it('removes zero-width characters a messenger may insert', () => {
    expect(normalizeInviteCode(`\uFEFF${CODE}\u200B`)).toBe(CODE)
    expect(normalizeInviteCode(`${CODE.slice(0, 8)}\u200D${CODE.slice(8)}`)).toBe(CODE)
  })

  it('accepts the code case-insensitively and returns it lowercased', () => {
    expect(normalizeInviteCode(CODE.toUpperCase())).toBe(CODE)
    expect(normalizeInviteCode(`${CODE.slice(0, 4)}${CODE.slice(4).toUpperCase()}`)).toBe(CODE)
  })

  it('keeps the hyphens', () => {
    expect(normalizeInviteCode(CODE)?.split('-')).toHaveLength(5)
  })

  it('refuses anything that is not shaped like an invite code', () => {
    expect(normalizeInviteCode('')).toBeNull()
    expect(normalizeInviteCode('   \n')).toBeNull()
    expect(normalizeInviteCode('not-an-invite-code')).toBeNull()
    expect(normalizeInviteCode(CODE.replace(/-/g, ''))).toBeNull()
    expect(normalizeInviteCode(CODE.slice(0, -1))).toBeNull()
    expect(normalizeInviteCode(`${CODE}0`)).toBeNull()
    expect(normalizeInviteCode(CODE.replace('3', 'g'))).toBeNull()
  })

  it('never extracts a code from a link or surrounding text', () => {
    expect(normalizeInviteCode(`https://example.org/onboarding?code=${CODE}`)).toBeNull()
    expect(normalizeInviteCode(`Your invite code: ${CODE}`)).toBeNull()
  })
})
