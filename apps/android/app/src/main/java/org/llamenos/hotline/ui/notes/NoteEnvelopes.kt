package org.llamenos.hotline.ui.notes

import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.hotline.crypto.NoteEnvelope
import org.llamenos.protocol.SharedNote

/**
 * Envelope recipient selection for notes, note replies, and case comments (#1023).
 *
 * The bug this guards: Android used to seal a note's content key ONLY to the
 * admin (`sessionState.adminPubkeys`), then store that admin envelope as the
 * `authorEnvelope` and send an empty `adminEnvelopes`. No client could read
 * the result — the desktop admin reads through `adminEnvelopes` (empty), and
 * the author reads `authorEnvelope`, which was sealed to the admin's key.
 *
 * The contract, matching iOS (`apps/ios/Sources/ViewModels/NotesViewModel.swift`)
 * and desktop (`src/client/routes/notes.tsx`):
 *  - Recipients are the author's encryption key PLUS each admin's.
 *  - `authorEnvelope` is the envelope whose RECIPIENT is the author, selected
 *    by pubkey — never by position.
 *  - `adminEnvelopes` holds every remaining envelope.
 */

/**
 * Recipient list for a note/reply/comment: the author's encryption pubkey
 * first, then each admin's, deduplicated (an admin writing a note is their
 * own author — one envelope, not two).
 */
internal fun noteRecipientPubkeys(authorPubkey: String, adminPubkeys: List<String>): List<String> =
    (listOf(authorPubkey) + adminPubkeys).distinct()

/**
 * Split freshly-sealed envelopes into the author's own envelope and the admin
 * envelopes, selected BY PUBKEY. Positional selection (`first()` / `drop(1)`)
 * was the second half of #1023: with the old recipient list the first envelope
 * was the admin's, and it was stored as the author's.
 *
 * Throws [NoSuchElementException] if no envelope is addressed to the author —
 * that can only happen if the recipient list was built without the author,
 * and failing loudly beats persisting a note nobody can read.
 */
internal fun splitAuthorAndAdminEnvelopes(
    envelopes: List<NoteEnvelope>,
    authorPubkey: String,
): Pair<NoteEnvelope, List<NoteEnvelope>> {
    val author = envelopes.first { it.recipientPubkey == authorPubkey }
    val admins = envelopes.filter { it.recipientPubkey != authorPubkey }
    return author to admins
}

/**
 * Candidate HPKE envelopes for reading a note or reply, most-likely first.
 *
 * Two envelopes may open for us:
 *  1. `authorEnvelope` — for notes written after the #1023 fix this opens only
 *     for the author. For notes written by the buggy Android build it was
 *     sealed to the ADMIN's key and stored under this field with an empty
 *     `adminEnvelopes` — trying it is the one-time read path that lets an
 *     admin recover those legacy notes.
 *  2. Our `adminEnvelopes` entry, matched by our encryption pubkey.
 *
 * Never gate the author envelope on `note.authorPubkey == ourPubkey`: the
 * server records `authorPubkey` as the author's SIGNING key (Ed25519) while
 * every envelope wraps for an ENCRYPTION key (X25519), so that comparison can
 * never match and silently dropped every note the author wrote themselves.
 * HPKE failing on an envelope that isn't ours is the check — it is cheap and
 * `CryptoService.decryptNote` already fails soft to null.
 */
internal fun noteReadCandidates(note: SharedNote, ourEncryptionPubkey: String): List<HpkeEnvelope> {
    val candidates = mutableListOf<HpkeEnvelope>()
    note.authorEnvelope?.let { authorEnv ->
        candidates += HpkeEnvelope(
            v = HpkeEnvelope.CURRENT_VERSION,
            labelId = HpkeEnvelope.LABEL_ID_NOTE_KEY,
            enc = authorEnv.enc,
            ct = authorEnv.ct,
        )
    }
    note.adminEnvelopes?.find { it.pubkey == ourEncryptionPubkey }?.let { adminEnv ->
        candidates += HpkeEnvelope(
            v = HpkeEnvelope.CURRENT_VERSION,
            labelId = HpkeEnvelope.LABEL_ID_NOTE_KEY,
            enc = adminEnv.enc,
            ct = adminEnv.ct,
        )
    }
    return candidates
}
