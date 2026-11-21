package org.llamenos.hotline.ui.reports

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.AuthInterceptor
import org.llamenos.hotline.api.RetryInterceptor
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.EncryptedMessage
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.LocationFieldValue
import org.llamenos.protocol.RecipientEnvelope

/**
 * Guards the cross-platform crypto-label consistency fixed by issue #768.
 *
 * Before this fix, `ReportsViewModel.createReport`/`createTypedReport` encrypted
 * report content with `CryptoService.encryptNote` (`LABEL_NOTE_KEY`), while
 * desktop encrypts/decrypts the same report content with `encryptMessage`/
 * `decryptMessage` (`LABEL_MESSAGE`) — see src/client/components/ReportForm.tsx,
 * src/client/components/cases/triage-case-creation-panel.tsx, and
 * src/client/components/cases/triage-report-content.tsx. HPKE enforces domain
 * separation at decrypt time (the Albrecht defense), so a report Android
 * created would have been undecryptable by anything expecting `LABEL_MESSAGE` —
 * a "cross-platform round trip" that a build or a passing typecheck cannot
 * catch, only an assertion on which crypto method gets called.
 *
 * These tests cannot exercise the actual HPKE label check (that requires the
 * native library, unavailable in a host-JVM unit test — see
 * [org.llamenos.hotline.CryptoServiceTest]), so instead they assert the
 * contract at the call-site: [ReportsViewModel] must call
 * [CryptoService.encryptMessage] and must never call [CryptoService.encryptNote]
 * for report content, matching desktop's choice of label.
 *
 * They also assert the *shape* of the plaintext handed to encryption: for a
 * report containing a `location`-typed field, the JSON payload must carry the
 * field's value as the same JSON string a location picker would produce
 * ([LocationFieldValue] — see [LocationPickerFieldLogicTest] and
 * `org.llamenos.hotline.model.LocationFieldValueTest`), inside a flat
 * `Map<String, String>` — the shape desktop's case/entity field editor also
 * encrypts (`JSON.stringify(Object.fromEntries(...))` in
 * src/client/routes/cases.tsx), not some other wrapper shape.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ReportsViewModelCryptoLabelTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** Real [ApiService] with IO dispatched synchronously; see HubScopedViewModelReloadTest. */
    private fun makeApiService(): ApiService =
        ApiService(
            authInterceptor = mockk<AuthInterceptor>(relaxed = true),
            retryInterceptor = mockk<RetryInterceptor>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            activeHubState = mockk<ActiveHubState>(relaxed = true),
        ).also { it.ioDispatcher = UnconfinedTestDispatcher() }

    @Test
    fun `createTypedReport encrypts field values with encryptMessage, never encryptNote`() = runTest {
        val cryptoService = mockk<CryptoService>(relaxed = true)
        val fakeEncrypted = EncryptedMessage(
            ciphertextHex = "deadbeef",
            envelopes = listOf(RecipientEnvelope(pubkey = "pub1", enc = "enc1", ct = "ct1")),
        )
        coEvery { cryptoService.encryptMessage(any(), any()) } returns fakeEncrypted

        val vm = ReportsViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = mockk<SessionState>(relaxed = true),
            activeHubState = mockk<ActiveHubState>(relaxed = true),
        )

        val locationValue = LocationFieldValue(
            address = "350 5th Ave, New York, NY",
            displayName = "Empire State Building",
            lat = 40.7484,
            lon = -73.9857,
        )
        val locationJson = Json.encodeToString(LocationFieldValue.serializer(), locationValue)

        vm.createTypedReport(
            reportTypeId = "rt-1",
            title = "Test report",
            fieldValues = mapOf(
                "incident_location" to locationJson,
                "notes" to "some free text",
            ),
        )

        val plaintextSlot = slot<String>()
        coVerify(exactly = 1) { cryptoService.encryptMessage(capture(plaintextSlot), any()) }
        coVerify(exactly = 0) { cryptoService.encryptNote(any(), any()) }

        // The encrypted plaintext is the flat field-values map, JSON-encoded —
        // not wrapped in any additional envelope — with the location field's
        // value preserved verbatim as the picker-produced JSON string.
        val decodedFields = json.decodeFromString<Map<String, String>>(plaintextSlot.captured)
        assertEquals(locationJson, decodedFields["incident_location"])
        assertEquals("some free text", decodedFields["notes"])

        // And that nested JSON string itself decodes back to the exact location
        // that was picked — the full round trip a shape mismatch would break silently.
        val decodedLocation = json.decodeFromString(
            LocationFieldValue.serializer(),
            decodedFields.getValue("incident_location"),
        )
        assertEquals(locationValue, decodedLocation)
    }

    @Test
    fun `createReport also encrypts with encryptMessage, never encryptNote`() = runTest {
        val cryptoService = mockk<CryptoService>(relaxed = true)
        coEvery { cryptoService.encryptMessage(any(), any()) } returns EncryptedMessage(
            ciphertextHex = "cafebabe",
            envelopes = emptyList(),
        )

        val vm = ReportsViewModel(
            apiService = makeApiService(),
            cryptoService = cryptoService,
            sessionState = mockk<SessionState>(relaxed = true),
            activeHubState = mockk<ActiveHubState>(relaxed = true),
        )

        vm.createReport(title = "Legacy report", category = null, body = "Body text")

        coVerify(exactly = 1) { cryptoService.encryptMessage(any(), any()) }
        coVerify(exactly = 0) { cryptoService.encryptNote(any(), any()) }
    }

    private fun makeViewModel(apiService: ApiService = makeApiService()) = ReportsViewModel(
        apiService = apiService,
        cryptoService = mockk(relaxed = true),
        sessionState = mockk(relaxed = true),
        activeHubState = mockk(relaxed = true),
    )

    @Test
    fun `searchLocations fails soft to an empty list for queries under 3 chars`() = runTest {
        val vm = makeViewModel()

        assertEquals(emptyList<Any>(), vm.searchLocations(""))
        assertEquals(emptyList<Any>(), vm.searchLocations("ab"))
    }

    @Test
    fun `searchLocations fails soft to an empty list when the request errors`() = runTest {
        // No hub URL configured -> ApiService.getBaseUrl() throws HubNotConfiguredException.
        // The location picker must never surface this as a crash or an error state —
        // a misconfigured/unreachable geocoding provider should just show no suggestions.
        val vm = makeViewModel()

        assertEquals(emptyList<Any>(), vm.searchLocations("New York"))
    }
}
