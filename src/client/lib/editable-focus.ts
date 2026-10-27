/**
 * True when keyboard focus is somewhere the user types text. Anything that wants to
 * act on a keystroke or take focus (global shortcuts, an incoming-call offer) must
 * leave the user alone then: moving focus mid-word sends their next characters to
 * the wrong place.
 */
export function isEditableFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return (el as HTMLElement).isContentEditable
}
