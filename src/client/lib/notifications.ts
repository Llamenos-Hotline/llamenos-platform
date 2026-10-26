/**
 * Notification system for incoming calls.
 * Handles audio ringtone, tab title flashing, and browser notifications.
 */

const RINGTONE_FREQUENCY = 440 // Hz (A4 note)
const RING_DURATION = 800 // ms
const RING_PAUSE = 400 // ms
const ORIGINAL_TITLE = document.title

let audioCtx: AudioContext | null = null
let ringInterval: ReturnType<typeof setInterval> | null = null
let titleInterval: ReturnType<typeof setInterval> | null = null
let isRinging = false

// --- Preferences (persisted in localStorage) ---

const PREFS_KEY = 'llamenos-notification-prefs'

interface NotificationPrefs {
  ringtoneEnabled: boolean
  browserNotificationsEnabled: boolean
}

function getPrefs(): NotificationPrefs {
  try {
    const stored = localStorage.getItem(PREFS_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return { ringtoneEnabled: true, browserNotificationsEnabled: true }
}

function savePrefs(prefs: NotificationPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export function getNotificationPrefs(): NotificationPrefs {
  return getPrefs()
}

export function setNotificationPrefs(prefs: Partial<NotificationPrefs>) {
  const current = getPrefs()
  const updated = { ...current, ...prefs }
  savePrefs(updated)
  return updated
}

// --- Audio Ringtone ---

function playRingTone() {
  if (!audioCtx) {
    audioCtx = new AudioContext()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }

  const oscillator = audioCtx.createOscillator()
  const gainNode = audioCtx.createGain()

  oscillator.connect(gainNode)
  gainNode.connect(audioCtx.destination)

  oscillator.frequency.value = RINGTONE_FREQUENCY
  oscillator.type = 'sine'
  gainNode.gain.value = 0.3

  // Fade out
  gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime)
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + RING_DURATION / 1000)

  oscillator.start()
  oscillator.stop(audioCtx.currentTime + RING_DURATION / 1000)
}

// --- Tab Title Flash ---

function startTitleFlash(incomingText: string) {
  if (titleInterval) return
  let showAlert = true
  titleInterval = setInterval(() => {
    document.title = showAlert ? incomingText : ORIGINAL_TITLE
    showAlert = !showAlert
  }, 1000)
}

function stopTitleFlash() {
  if (titleInterval) {
    clearInterval(titleInterval)
    titleInterval = null
  }
  document.title = ORIGINAL_TITLE
}

// --- Browser Notifications ---

export async function requestPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

function showBrowserNotification(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const notification = new Notification(title, {
    body,
    icon: '/favicon.svg',
    tag: 'incoming-call', // Replaces existing notification
  })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

// --- Public API ---

/**
 * `title` and `body` are already translated by the caller and must stay generic —
 * never name or number the caller: both reach the tab title and the OS
 * notification, which show on a lock screen.
 */
export async function startRinging(title: string, body: string) {
  if (isRinging) return
  isRinging = true

  const prefs = getPrefs()

  // Audio ringtone
  if (prefs.ringtoneEnabled) {
    playRingTone()
    ringInterval = setInterval(playRingTone, RING_DURATION + RING_PAUSE)
  }

  // Tab title flash
  startTitleFlash(title)

  // Browser notification
  if (prefs.browserNotificationsEnabled) {
    const granted = await requestPermission()
    if (granted) {
      showBrowserNotification(title, body)
    }
  }
}

export function stopRinging() {
  if (!isRinging) return
  isRinging = false

  if (ringInterval) {
    clearInterval(ringInterval)
    ringInterval = null
  }

  stopTitleFlash()
}

export function isCurrentlyRinging() {
  return isRinging
}
