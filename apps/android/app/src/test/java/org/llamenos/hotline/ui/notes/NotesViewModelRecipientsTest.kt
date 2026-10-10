package org.llamenos.hotline.ui.notes

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.AuthInterceptor
import org.llamenos.hotline.api.RetryInterceptor
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.EncryptedNote
import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.NoteEnvelope
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.ui.cases.CaseManagementViewModel

/**
 * Guards the recipient-list wiring fixed by issue #1023 at the ViewModel
 * call sites. [NoteEnvelopesTest] pins the pure envelope-selection logic;
 * these tests assert the ViewModels actually pass the author's encryption
 * pubkey plus the admin pubkeys to [CryptoService.encryptNote] — the call
 * that used to receive ONLY the admin pubkeys, producing notes no client
 * could read.
 *
 * The same real-[ApiService]-with-test-dispatcher strategy as
 * `ReportsViewModelCryptoLabelTest` is used: `ApiService.request` is
 * `suspend inline reified` and cannot be intercepted by MockK, and with no
 * hub URL configured it throws [IllegalStateException] AFTER the encryption
 * call — which is all these tests need to observe. The ViewModels catch that
 * exception into their error state, so it never fails the test.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotesViewModelRecipientsTest {

    private val authorPub = "aa".repeat(32)
    private val adminPub = "bb".repeat(32)

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makeApiService(): ApiService =
        ApiService(
            authInterceptor = mockk<AuthInterceptor>(relaxed = true),
            retryInterceptor = mockk<RetryInterceptor>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            activeHubState = mockk<ActiveHubState>(relaxed = true),
        ).also { it.ioDispatcher = UnconfinedTestDispatcher() }

    private fun makeCryptoService(): CryptoService {
        val cryptoService = mockk<CryptoService>(relaxed = true)
        every { cryptoService.encryptionPubkeyHex } returns authorPub
        coEvery { cryptoService.encryptNote(any(), any()) } answers {
            val recipients = secondArg<List<String>>()
            EncryptedNote(
                ciphertextHex = "deadbeef",
                envelopes = recipients.map { pub ->
                    NoteEnvelope(
                        recipientPubkey = pub,
                        hpkeEnvelope = HpkeEnvelope(v = 3, labelId = 0, enc = "enc-$pub", ct = "ct-$pub"),
                    )
                },
            )
        }
        return cryptoService
    }

    private fun makeSessionState(): SessionState {
        val sessionState = mockk<SessionState>(relaxed = true)
        every { sessionState.adminPubkeys } returns listOf(adminPub)
        return sessionState
    }

    @Test
    fun `createNote seals to the author plus the admin`() = runTest {
        val cryptoService = makeCryptoService()
        val vm = NotesViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = makeSessionState(),
            activeHubState = mockk<ActiveHubState>(relaxed = true) {
                every { activeHubId } returns MutableStateFlow(null)
            },
        )

        vm.createNote(text = "call note", fieldValues = emptyMap(), callId = "call-1")

        val recipientsSlot = slot<List<String>>()
        coVerify(exactly = 1) { cryptoService.encryptNote(any(), capture(recipientsSlot)) }
        assertEquals(listOf(authorPub, adminPub), recipientsSlot.captured)
    }

    @Test
    fun `updateNote seals to the author plus the admin`() = runTest {
        val cryptoService = makeCryptoService()
        val vm = NotesViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = makeSessionState(),
            activeHubState = mockk<ActiveHubState>(relaxed = true) {
                every { activeHubId } returns MutableStateFlow(null)
            },
        )

        vm.updateNote(noteId = "note-1", text = "updated", fieldValues = emptyMap())

        val recipientsSlot = slot<List<String>>()
        coVerify(exactly = 1) { cryptoService.encryptNote(any(), capture(recipientsSlot)) }
        assertEquals(listOf(authorPub, adminPub), recipientsSlot.captured)
    }

    @Test
    fun `sendReply seals to the author plus the admin`() = runTest {
        val cryptoService = makeCryptoService()
        val vm = NotesViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = makeSessionState(),
            activeHubState = mockk<ActiveHubState>(relaxed = true) {
                every { activeHubId } returns MutableStateFlow(null)
            },
        )

        vm.sendReply(noteId = "note-1", text = "reply text")

        val recipientsSlot = slot<List<String>>()
        coVerify(exactly = 1) { cryptoService.encryptNote(any(), capture(recipientsSlot)) }
        assertEquals(listOf(authorPub, adminPub), recipientsSlot.captured)
    }

    @Test
    fun `case addComment seals to the author plus the admin`() = runTest {
        val cryptoService = makeCryptoService()
        val vm = CaseManagementViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = makeSessionState(),
            activeHubState = mockk<ActiveHubState>(relaxed = true) {
                every { activeHubId } returns MutableStateFlow(null)
            },
        )

        vm.addComment(recordId = "record-1", comment = "case comment")

        val recipientsSlot = slot<List<String>>()
        coVerify(exactly = 1) { cryptoService.encryptNote(any(), capture(recipientsSlot)) }
        assertEquals(listOf(authorPub, adminPub), recipientsSlot.captured)
    }
}
