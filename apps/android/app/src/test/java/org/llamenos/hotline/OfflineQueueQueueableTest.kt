package org.llamenos.hotline

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.service.OfflineQueue

/**
 * Which failed requests [OfflineQueue] may replay. Identity writes (sigchain links,
 * PUK envelopes) must never be replayed: a stale PUK envelope upsert would replace
 * the envelope of the PUK the user's chain actually names.
 */
class OfflineQueueQueueableTest {

    @Test
    fun `ordinary writes are queueable`() {
        assertTrue(OfflineQueue.isQueueable("POST", "/api/notes"))
        assertTrue(OfflineQueue.isQueueable("patch", "/api/notes/abc"))
        assertTrue(OfflineQueue.isQueueable("DELETE", "/api/bans/123"))
    }

    @Test
    fun `reads are not queueable`() {
        assertFalse(OfflineQueue.isQueueable("GET", "/api/notes"))
    }

    @Test
    fun `sigchain appends are not queueable`() {
        val path = "/api/users/${"a".repeat(64)}/sigchain"
        assertTrue(OfflineQueue.isIdentityWrite(path))
        assertFalse(OfflineQueue.isQueueable("POST", path))
    }

    @Test
    fun `PUK envelope writes are not queueable`() {
        assertFalse(OfflineQueue.isQueueable("POST", "/api/puk/envelopes"))
    }

    @Test
    fun `other user routes stay queueable`() {
        assertTrue(OfflineQueue.isQueueable("PATCH", "/api/users/${"a".repeat(64)}"))
    }
}
