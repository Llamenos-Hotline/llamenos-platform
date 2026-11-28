package org.llamenos.hotline.service

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.core.ActiveDeviceKey
import org.llamenos.core.SigchainLink
import org.llamenos.core.SigchainVerifiedState
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.DeviceKeyState
import org.llamenos.hotline.crypto.EncryptedDeviceKeys
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.ui.auth.storeDeviceKeys
import org.llamenos.protocol.AppendSigchainLinkBody
import org.llamenos.protocol.DistributePukEnvelopesBody
import org.llamenos.protocol.DistributePukEnvelopesBodyEnvelope
import org.llamenos.protocol.DistributePukEnvelopesResponse
import org.llamenos.protocol.SigchainLinkRecord
import org.llamenos.protocol.SigchainResponse
import org.llamenos.protocol.SigchainResponseLink
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * #3051: [DeviceRegistrationManager.ensureIdentity] finishes an identity
 * initialisation that stopped part-way, and a restore of another identity does
 * not leave it failing closed.
 *
 * The `puk_epoch` link binds the PUK's public keys into the chain; a chain with
 * genesis but no `puk_epoch` leaves the generation-1 envelope with nothing to be
 * checked against. Such a chain must be resumed, not verified as if finished.
 *
 * JVM tests have no native library, so [CryptoService] is answered by a
 * self-consistent stand-in for the crate: links are hash-chained over their
 * payload, and its verifier recomputes every hash and reads the genesis's X-Wing
 * key, so a tampered prefix fails here as it would in Rust. The crate's own
 * verifier is exercised over UniFFI by the instrumented DeviceBindingVectorTest.
 * The server is an in-memory chain that refuses an append off its head, and
 * upserts envelopes on (device, generation), as the real routes do.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceIdentityResumeTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val random = SecureRandom()
    private fun hex(bytes: Int) = ByteArray(bytes).also(random::nextBytes).joinToString("") { "%02x".format(it) }

    private data class Device(val user: String, val x25519: String, val kem: String, val deviceId: String)

    private fun newDevice(deviceId: String) = Device(hex(32), hex(32), hex(1216), deviceId)

    // ---- the server ----
    private val links = mutableListOf<SigchainResponseLink>()
    private val envelopes = mutableListOf<DistributePukEnvelopesBodyEnvelope>()

    /** The PUK states the stand-in for Rust created, in order. */
    private val puks = mutableListOf<JsonObject>()

    private lateinit var apiService: ApiService
    private lateinit var cryptoService: CryptoService
    private lateinit var store: InMemoryKeyValueStore
    private lateinit var device: Device

    @Before
    fun setup() {
        store = InMemoryKeyValueStore()
        apiService = mockk()
        cryptoService = mockk()
        coEvery { apiService.getSigchain(any()) } answers { SigchainResponse(links = links.toList()) }
        coEvery { apiService.appendSigchainLink(any(), any()) } answers { append(firstArg(), secondArg()) }
        coEvery { apiService.distributePukEnvelopes(any()) } answers {
            val body = firstArg<DistributePukEnvelopesBody>()
            for (e in body.envelopes) {
                envelopes.removeAll { it.deviceID == e.deviceID && it.generation == e.generation }
                envelopes.add(e)
            }
            DistributePukEnvelopesResponse(distributed = body.envelopes.size, envelopes = emptyList())
        }
        unlock(newDevice("device-identity"))
    }

    private fun append(user: String, body: AppendSigchainLinkBody): SigchainLinkRecord {
        val head = links.lastOrNull()
        if (body.seqNo != (head?.seqNo ?: 0) + 1) throw ApiException(409, "sequence mismatch")
        if (body.prevHash != head?.hash) throw ApiException(409, "prevHash mismatch")
        val link = SigchainResponseLink(
            createdAt = "2026-11-27T00:00:00Z",
            hash = body.hash,
            id = java.util.UUID.randomUUID().toString(),
            linkType = body.linkType.value,
            payload = body.payload,
            seqNo = body.seqNo,
            signature = body.signature,
            signerDeviceID = body.signerDeviceID,
            signerPubkey = body.signerPubkey,
            timestamp = body.timestamp,
            userPubkey = user,
            prevHash = body.prevHash,
        )
        links.add(link)
        return SigchainLinkRecord(
            createdAt = link.createdAt, hash = link.hash, id = link.id, linkType = link.linkType,
            payload = link.payload, seqNo = link.seqNo, signature = link.signature,
            signerDeviceID = link.signerDeviceID, signerPubkey = link.signerPubkey,
            timestamp = link.timestamp, userPubkey = user, prevHash = link.prevHash,
        )
    }

    // ---- the stand-in for Rust CryptoState ----

    private fun entryHash(seq: Long, prevHash: String?, timestamp: String, deviceId: String, signer: String, payloadJson: String): String {
        val canonical = "$seq|$prevHash|$timestamp|$deviceId|$signer|${Json.parseToJsonElement(payloadJson)}"
        return MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /** Load [d] as the unlocked device: its keys, and the operations Rust performs with them. */
    private fun unlock(d: Device) {
        device = d
        every { cryptoService.signingPubkeyHex } returns d.user
        every { cryptoService.kemPubkeyHex } returns d.kem
        every { cryptoService.deviceId } returns d.deviceId
        coEvery { cryptoService.userInitPayload() } answers {
            buildJsonObject {
                put("type", "user_init")
                put("deviceId", d.deviceId)
                put("devicePubkey", d.user)
                put("deviceEncryptionPubkey", d.x25519)
                put("encryptionPubkey", d.kem)
                put("format", 2)
                put("pop", hex(64))
            }.toString()
        }
        coEvery { cryptoService.createInitialPuk() } answers {
            val state = buildJsonObject {
                put("generation", 1)
                put("signPubkeyHex", hex(32))
                put("dhPubkeyHex", hex(32))
            }
            puks.add(state)
            buildJsonObject {
                put("pukState", state)
                put("envelope", buildJsonObject { put("ct", hex(48)); put("enc", hex(32)) })
            }.toString()
        }
        coEvery { cryptoService.createSigchainLink(any(), any(), any(), any(), any()) } answers {
            val id = arg<String>(0)
            val seq = arg<Long>(1)
            val prev = arg<String?>(2)
            val ts = arg<String>(3)
            val payload = arg<String>(4)
            val h = entryHash(seq, prev, ts, d.deviceId, d.user, payload)
            SigchainLink(id, seq.toULong(), prev, h, d.deviceId, d.user, hex(64), ts, payload)
        }
        coEvery { cryptoService.verifySigchain(any()) } answers { verify(firstArg()) }
    }

    private fun verify(linksJson: String): SigchainVerifiedState {
        val chain = Json.parseToJsonElement(linksJson) as JsonArray
        if (chain.isEmpty()) throw CryptoException("sigchain must have at least one link")
        var prev: String? = null
        var genesis: JsonObject? = null
        chain.forEachIndexed { i, el ->
            val l = el.jsonObject
            val seq = l.getValue("seq").jsonPrimitive.content.toLong()
            val prevHash = (l.getValue("prevHash") as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
            val signer = l.getValue("signerPubkey").jsonPrimitive.content
            val payloadJson = l.getValue("payloadJson").jsonPrimitive.content
            val h = entryHash(seq, prevHash, l.getValue("timestamp").jsonPrimitive.content,
                l.getValue("signerDeviceId").jsonPrimitive.content, signer, payloadJson)
            if (seq != i + 1L || prevHash != prev) throw CryptoException("chain_prev_hash at seq $seq")
            if (h != l.getValue("entryHash").jsonPrimitive.content) throw CryptoException("entry hash mismatch at seq $seq")
            val payload = Json.parseToJsonElement(payloadJson).jsonObject
            if (i == 0) {
                if (payload["type"]?.jsonPrimitive?.content != "user_init" ||
                    payload["devicePubkey"]?.jsonPrimitive?.content != signer
                ) {
                    throw CryptoException("bad genesis")
                }
                genesis = payload
            } else if (signer != genesis!!.getValue("devicePubkey").jsonPrimitive.content) {
                throw CryptoException("unauthorised signer at seq $seq")
            }
            prev = h
        }
        val g = genesis!!
        val user = g.getValue("devicePubkey").jsonPrimitive.content
        return SigchainVerifiedState(
            userPubkey = user,
            verifiedCount = chain.size.toULong(),
            headSeq = chain.size.toULong(),
            headHash = prev!!,
            activeDevicePubkeys = listOf(user),
            activeDeviceKeys = listOf(ActiveDeviceKey(user, g.getValue("encryptionPubkey").jsonPrimitive.content, 2u)),
            namedKeys = emptyList(),
        )
    }

    private fun manager() = DeviceRegistrationManager(apiService, cryptoService, store, CoroutineScope(testDispatcher))

    /** Stop an initialisation after its genesis: the PUK envelope POST fails. */
    private suspend fun strandAfterGenesis() {
        coEvery { apiService.distributePukEnvelopes(any()) } throws java.io.IOException("offline") andThenAnswer {
            val body = firstArg<DistributePukEnvelopesBody>()
            envelopes.addAll(body.envelopes)
            DistributePukEnvelopesResponse(distributed = body.envelopes.size, envelopes = emptyList())
        }
        assertTrue(manager().ensureIdentity().isFailure)
        assertEquals(listOf("genesis"), links.map { it.linkType })
    }

    /**
     * The chain the server holds is complete: genesis then a generation-1
     * `puk_epoch` naming the PUK whose envelope was stored for this device, and
     * this device recorded that chain's head.
     */
    private fun assertCompleteChain() {
        assertEquals(listOf("genesis", "puk_epoch"), links.map { it.linkType })
        val epoch = links[1].payload!!.jsonObject
        val puk = puks.last()
        assertEquals("puk_epoch", epoch.getValue("type").jsonPrimitive.content)
        assertEquals(1, epoch.getValue("generation").jsonPrimitive.int)
        assertEquals(puk.getValue("signPubkeyHex"), epoch.getValue("signPubkey"))
        assertEquals(puk.getValue("dhPubkeyHex"), epoch.getValue("dhPubkey"))
        assertEquals(listOf(device.deviceId to 1), envelopes.map { it.deviceID to it.generation })
        verify(cryptoLinksJson())
        assertEquals("${device.user}:2:${links[1].hash}", store.retrieve(KeystoreService.KEY_SIGCHAIN_HEAD))
    }

    private fun cryptoLinksJson(): String = JsonArray(
        links.map { l ->
            buildJsonObject {
                put("seq", l.seqNo)
                put("prevHash", l.prevHash?.let { JsonPrimitive(it) } ?: JsonNull)
                put("entryHash", l.hash)
                put("signerDeviceId", l.signerDeviceID)
                put("signerPubkey", l.signerPubkey)
                put("timestamp", l.timestamp)
                put("payloadJson", l.payload.toString())
            }
        },
    ).toString()

    @Test
    fun `a genesis-only chain is resumed to its puk_epoch`() = runTest(testDispatcher) {
        strandAfterGenesis()

        val result = manager().ensureIdentity()

        assertTrue(result.exceptionOrNull()?.toString(), result.isSuccess)
        assertCompleteChain()
    }

    @Test
    fun `a genesis-only chain this device recorded as its verified head is resumed`() = runTest(testDispatcher) {
        strandAfterGenesis()
        // A build that took the stranded chain as initialised verified it and kept its head.
        store.store(KeystoreService.KEY_SIGCHAIN_HEAD, "${device.user}:1:${links[0].hash}")

        val result = manager().ensureIdentity()

        assertTrue(result.exceptionOrNull()?.toString(), result.isSuccess)
        assertCompleteChain()
    }

    @Test
    fun `a served genesis that does not verify is not extended and gets no PUK`() = runTest(testDispatcher) {
        strandAfterGenesis()
        // The server now serves a genesis naming another X-Wing key: its hash no longer matches.
        val forgedPayload = JsonObject(links[0].payload!!.jsonObject + ("encryptionPubkey" to JsonPrimitive(hex(1216))))
        val forged = links[0].copy(payload = forgedPayload)
        links[0] = forged
        val puksBefore = puks.size

        assertTrue(manager().ensureIdentity().isFailure)

        assertEquals(listOf(forged), links)
        assertEquals(emptyList<DistributePukEnvelopesBodyEnvelope>(), envelopes)
        assertEquals(puksBefore, puks.size)
    }

    @Test
    fun `restoring another identity clears its head and leaves ensureIdentity working`() = runTest(testDispatcher) {
        // Identity A verified its chain on this phone and recorded the head.
        val previous = newDevice("device-previous")
        store.store(KeystoreService.KEY_SIGCHAIN_HEAD, "${previous.user}:3:${hex(32)}")

        // A backup of identity B is restored here and stored as this device's keys.
        store.storeDeviceKeys(encryptedKeysFor(device))

        assertNull(store.retrieve(KeystoreService.KEY_SIGCHAIN_HEAD))
        val result = manager().ensureIdentity()
        assertTrue(result.exceptionOrNull()?.toString(), result.isSuccess)
        assertCompleteChain()
    }

    @Test
    fun `restoring the same identity keeps its head as the rollback guard`() = runTest(testDispatcher) {
        assertTrue(manager().ensureIdentity().isSuccess)
        val head = store.retrieve(KeystoreService.KEY_SIGCHAIN_HEAD)

        store.storeDeviceKeys(encryptedKeysFor(device))

        assertEquals(head, store.retrieve(KeystoreService.KEY_SIGCHAIN_HEAD))
        // The guard still holds: the server rolling the chain back is refused, not re-initialised.
        links.clear()
        assertTrue(manager().ensureIdentity().isFailure)
        assertTrue(links.isEmpty())
    }

    private fun encryptedKeysFor(d: Device) = EncryptedDeviceKeys(
        kdfVersion = 2u,
        salt = hex(16),
        argon2MCost = 65_536u,
        argon2TCost = 3u,
        argon2PCost = 4u,
        nonce = hex(24),
        ciphertext = hex(96),
        state = DeviceKeyState(d.deviceId, d.user, d.x25519, d.kem),
    )
}
