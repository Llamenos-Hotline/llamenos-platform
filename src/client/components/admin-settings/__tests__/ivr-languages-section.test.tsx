/**
 * #2217: what the admin screen says a caller presses is what the caller hears.
 * The keypad has ten digits, so the menu holds ten languages and an 11th is
 * refused with its own message; the screen flags enabled languages nobody in the
 * hub speaks as a count only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import type { IvrLanguageSettings } from '@/lib/api'

const toasts: { message: string; type?: string }[] = []
const saved: string[][] = []

const toastFns = vi.hoisted(() => ({ value: undefined as unknown as { toast: (message: string, type?: string) => void } }))
vi.mock('@/lib/toast', () => ({ useToast: () => toastFns.value }))
toastFns.value = { toast: (message, type) => { toasts.push({ message, type }) } }
vi.mock('@/lib/api', () => ({
  updateIvrLanguages: vi.fn(async (data: { enabledLanguages: string[] }) => {
    saved.push(data.enabledLanguages)
    return { enabledLanguages: data.enabledLanguages, uncoveredLanguageCount: 0 }
  }),
}))
vi.mock('@/components/settings-section', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

import { IvrLanguagesSection } from '../ivr-languages-section'

const KEYPAD = ['es', 'en', 'zh', 'tl', 'vi', 'ar', 'fr', 'ht', 'ko', 'ru']

function renderSection(settings: IvrLanguageSettings, onChange = vi.fn()) {
  render(<IvrLanguagesSection settings={settings} onChange={onChange} expanded onToggle={() => {}} />)
  return onChange
}

describe('IvrLanguagesSection', () => {
  beforeEach(() => {
    toasts.length = 0
    saved.length = 0
  })
  afterEach(cleanup)

  it('shows the digit a caller presses for each position, with 0 for the tenth', () => {
    renderSection({ enabledLanguages: KEYPAD, uncoveredLanguageCount: 0 })

    const digits = KEYPAD.map(code => screen.getByTestId(`ivr-digit-${code}`).textContent)
    expect(digits).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
  })

  it('refuses an 11th language with its own message and saves nothing', async () => {
    const onChange = renderSection({ enabledLanguages: KEYPAD, uncoveredLanguageCount: 0 })

    expect(screen.getByTestId('ivr-menu-full').textContent).toContain('10')
    fireEvent.click(screen.getByTestId('ivr-enable-hi'))

    await waitFor(() => expect(toasts).toHaveLength(1))
    expect(toasts[0].type).toBe('error')
    expect(toasts[0].message).toBe(screen.getByTestId('ivr-menu-full').textContent)
    expect(saved).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('accepts a language while a digit is still free, giving it the tenth digit', async () => {
    const onChange = renderSection({ enabledLanguages: KEYPAD.slice(0, 9), uncoveredLanguageCount: 0 })

    expect(screen.queryByTestId('ivr-menu-full')).toBeNull()
    fireEvent.click(screen.getByTestId('ivr-enable-hi'))

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(saved).toEqual([[...KEYPAD.slice(0, 9), 'hi']])
    expect(toasts).toEqual([])
  })

  it('still lets an admin disable a language when the menu is full', async () => {
    renderSection({ enabledLanguages: KEYPAD, uncoveredLanguageCount: 0 })

    fireEvent.click(screen.getAllByRole('switch')[0])

    await waitFor(() => expect(saved).toEqual([KEYPAD.slice(1)]))
  })

  it('shows no digit for a language past the tenth in a list saved before the cap', () => {
    renderSection({ enabledLanguages: [...KEYPAD, 'hi'], uncoveredLanguageCount: 0 })

    expect(screen.getByTestId('ivr-digit-hi').textContent).toBe('–')
  })

  it('flags enabled languages nobody speaks as a count, naming no language', () => {
    renderSection({ enabledLanguages: ['en', 'es', 'vi'], uncoveredLanguageCount: 2 })

    const flag = screen.getByTestId('ivr-uncovered-flag')
    expect(flag.getAttribute('data-count')).toBe('2')
    expect(flag.textContent).toContain('2')
    expect(flag.textContent).not.toMatch(/Spanish|Vietnamese|Español|Tiếng/i)
  })

  it('shows no flag when every enabled language has a speaker', () => {
    renderSection({ enabledLanguages: ['en', 'es'], uncoveredLanguageCount: 0 })

    expect(screen.queryByTestId('ivr-uncovered-flag')).toBeNull()
  })
})
