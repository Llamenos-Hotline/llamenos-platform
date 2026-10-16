package org.llamenos.hotline.viewmodel

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.HubOnboardApi
import org.llamenos.protocol.ChannelConfig
import org.llamenos.protocol.HubOnboardingState
import org.llamenos.protocol.HubSetupStatus
import org.llamenos.protocol.HubUsage
import org.llamenos.protocol.SharedChannelConfig

/**
 * A channel switch the user has just flipped must not be rolled back by a server
 * response that was issued before the flip (#1091).
 *
 * The onboarding sheet opens on the channel step while `startOnboarding` is still
 * in flight, and the settings screen loads provider status on creation, so the
 * first tap on a switch can land before either response. Each response carries a
 * channel config read before that tap; applying it wholesale used to put the
 * switch back to its old position — a tap that was accepted, then silently undone
 * (`ToggleableState` still `Off` after the click).
 *
 * Responses are gated on [CompletableDeferred]s so the ordering is exact rather
 * than depending on emulator timing.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubCommunicationsViewModelChannelsTest {

    private lateinit var api: HubOnboardApi

    private val noChannels = ChannelConfig()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        api = mockk()
        coEvery { api.getUsage() } returns Result.success(HubUsage())
        coEvery { api.getProviderStatus() } returns Result.success(status())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun status() = HubSetupStatus(
        channelsConfigured = emptyList(),
        channelsPending = emptyList(),
        hubID = "hub-a",
        numbersProvisioned = 0,
        onboardingComplete = false,
        providerConnected = false,
    )

    private fun onboardingState(channels: ChannelConfig = noChannels) = HubOnboardingState(
        channelConfig = SharedChannelConfig(
            email = channels.email,
            rcs = channels.rcs,
            signal = channels.signal,
            sms = channels.sms,
            telegram = channels.telegram,
            voice = channels.voice,
            whatsapp = channels.whatsapp,
        ),
        hubID = "hub-a",
    )

    @Test
    fun `toggle made while startOnboarding is in flight survives its response`() {
        val started = CompletableDeferred<Result<HubOnboardingState>>()
        coEvery { api.startOnboarding(any()) } coAnswers { started.await() }
        coEvery { api.completeStep(any(), any()) } returns Result.success(onboardingState())
        coEvery { api.updateChannel("voice", true) } returns Result.success(noChannels.copy(voice = true))

        val vm = HubCommunicationsViewModel(api)
        vm.startOnboarding(templateId = null)
        vm.toggleChannel("voice", true)
        assertTrue(vm.uiState.value.channels.voice)

        // The response was computed before the toggle: it still says voice is off.
        started.complete(Result.success(onboardingState()))

        assertTrue(
            "startOnboarding's pre-toggle channel config rolled the switch back",
            vm.uiState.value.channels.voice,
        )
    }

    @Test
    fun `toggle made while the initial status load is in flight survives its response`() {
        val loading = CompletableDeferred<Result<HubSetupStatus>>()
        coEvery { api.getProviderStatus() } coAnswers { loading.await() }
        coEvery { api.updateChannel("voice", true) } returns Result.success(noChannels.copy(voice = true))

        val vm = HubCommunicationsViewModel(api)
        vm.toggleChannel("voice", true)

        loading.complete(Result.success(status()))

        assertTrue(
            "the initial provider-status load rolled the switch back",
            vm.uiState.value.channels.voice,
        )
    }

    @Test
    fun `save response for an earlier toggle does not undo a later toggle`() {
        val voiceSaved = CompletableDeferred<Result<ChannelConfig>>()
        coEvery { api.updateChannel("voice", true) } coAnswers { voiceSaved.await() }
        coEvery { api.updateChannel("sms", true) } returns
            Result.success(noChannels.copy(voice = true, sms = true))

        val vm = HubCommunicationsViewModel(api)
        vm.toggleChannel("voice", true)
        vm.toggleChannel("sms", true)

        // The voice save was answered before sms was persisted, so it reports sms off.
        voiceSaved.complete(Result.success(noChannels.copy(voice = true)))

        val channels = vm.uiState.value.channels
        assertTrue(channels.voice)
        assertTrue("the earlier save's response undid the later toggle", channels.sms)
    }

    @Test
    fun `failed save reverts only its own channel`() {
        val voiceSaved = CompletableDeferred<Result<ChannelConfig>>()
        coEvery { api.updateChannel("voice", true) } coAnswers { voiceSaved.await() }
        coEvery { api.updateChannel("sms", true) } returns
            Result.success(noChannels.copy(sms = true))

        val vm = HubCommunicationsViewModel(api)
        vm.toggleChannel("voice", true)
        vm.toggleChannel("sms", true)

        voiceSaved.complete(Result.failure(IllegalStateException("boom")))

        val channels = vm.uiState.value.channels
        assertFalse("the failed channel must roll back", channels.voice)
        assertTrue("a failed save must not roll back an unrelated channel", channels.sms)
        assertEquals("boom", vm.uiState.value.saveError)
    }

    @Test
    fun `server config is adopted when the user has not touched a switch`() {
        coEvery { api.startOnboarding(any()) } returns Result.success(onboardingState())
        coEvery { api.completeStep(any(), any()) } returns
            Result.success(onboardingState(noChannels.copy(sms = true)))

        val vm = HubCommunicationsViewModel(api)
        vm.startOnboarding(templateId = null)

        assertTrue(vm.uiState.value.channels.sms)
    }
}
