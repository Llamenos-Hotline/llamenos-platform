package org.llamenos.hotline.ui.auth

/**
 * Maximum PIN length accepted by the PIN set and unlock pads.
 *
 * Single source of truth for both [PINSetScreen] and [PINUnlockScreen] —
 * each wires this into PINPad's `maxLength` so the pads always agree.
 */
const val PIN_MAX_LENGTH = 8
