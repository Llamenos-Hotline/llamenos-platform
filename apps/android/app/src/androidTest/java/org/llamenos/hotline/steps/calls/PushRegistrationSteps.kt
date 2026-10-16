package org.llamenos.hotline.steps.calls

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import dagger.hilt.android.EntryPointAccessors
import io.cucumber.java.en.Then
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.di.PushRegistrationEntryPoint
import org.llamenos.hotline.service.PushRegistrationManager
import org.llamenos.hotline.steps.BaseSteps

/**
 * Step definitions for push-registration.feature (#955).
 *
 * Asserts against the real [PushRegistrationManager] singleton from the
 * production Dagger graph, so the state under test is the state the app
 * itself settled on after the login flow ran `ensureRegistered()`.
 */
class PushRegistrationSteps : BaseSteps() {

    private val entryPoint: PushRegistrationEntryPoint
        get() = EntryPointAccessors.fromApplication(
            LlamenosApp.instance,
            PushRegistrationEntryPoint::class.java,
        )

    @Then("the push registration state should be known")
    fun thePushRegistrationStateShouldBeKnown() {
        val manager = entryPoint.pushRegistrationManager()
        // ensureRegistered() runs on the application scope after login — wait
        // for it to settle into a terminal state (never UNKNOWN afterwards).
        var state = manager.distributorState.value
        val deadline = System.currentTimeMillis() + 10_000
        while (state == PushRegistrationManager.DistributorState.UNKNOWN &&
            System.currentTimeMillis() < deadline
        ) {
            Thread.sleep(100)
            state = manager.distributorState.value
        }
        assert(state != PushRegistrationManager.DistributorState.UNKNOWN) {
            "Push registration never completed after login — state stayed UNKNOWN. " +
                "AuthViewModel must call PushRegistrationManager.ensureRegistered()."
        }
    }

    @Then("the dashboard push warning visibility should match the installed distributor state")
    fun theDashboardPushWarningShouldMatchDistributorState() {
        val distributors = entryPoint.unifiedPushGateway().getDistributors()

        // Navigate to the dashboard tab first (the warning card lives there).
        navigateToTab(NAV_DASHBOARD)
        composeRule.waitForIdle()

        if (distributors.isEmpty()) {
            // No distributor installed: the app must say so explicitly (with an
            // install-ntfy pointer) instead of failing silently.
            onNodeWithTag("push-distributor-warning", useUnmergedTree = true).assertIsDisplayed()
        } else {
            // A distributor exists: registration must have succeeded, so no warning.
            onNodeWithTag("push-distributor-warning", useUnmergedTree = true).assertDoesNotExist()
        }
    }
}
