package org.llamenos.hotline

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Boundary tests for the background auto-lock decision (#1535).
 *
 * [MainActivity.shouldAutoLock] is the trigger half of the auto-lock: when it
 * fires, `CryptoService.lock()` drops the device keys and SessionLockEffect
 * moves the UI to the unlock screen. These pin the timeout semantics — a
 * never-backgrounded app never locks, and the lock trips only strictly past
 * the timeout.
 */
class MainActivityAutoLockTest {

    @Test
    fun `never backgrounded does not lock`() {
        assertFalse(MainActivity.shouldAutoLock(null, System.currentTimeMillis()))
    }

    @Test
    fun `one millisecond under the timeout does not lock`() {
        val now = System.currentTimeMillis()
        assertFalse(MainActivity.shouldAutoLock(now - MainActivity.LOCK_TIMEOUT_MS + 1, now))
    }

    @Test
    fun `exactly at the timeout does not lock`() {
        val now = System.currentTimeMillis()
        assertFalse(MainActivity.shouldAutoLock(now - MainActivity.LOCK_TIMEOUT_MS, now))
    }

    @Test
    fun `past the timeout locks`() {
        val now = System.currentTimeMillis()
        assertTrue(MainActivity.shouldAutoLock(now - MainActivity.LOCK_TIMEOUT_MS - 1, now))
    }

    @Test
    fun `long absence locks`() {
        val now = System.currentTimeMillis()
        assertTrue(MainActivity.shouldAutoLock(now - 60L * 60L * 1000L, now))
    }
}
