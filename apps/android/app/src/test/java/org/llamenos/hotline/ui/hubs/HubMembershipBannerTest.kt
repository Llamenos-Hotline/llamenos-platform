package org.llamenos.hotline.ui.hubs

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.R
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class HubMembershipBannerTestApp : Application()

/** The notice above every tab for a hub list that could not be read (#2565). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = HubMembershipBannerTestApp::class)
class HubMembershipBannerTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `the failure is named and retry re-reads the hub list`() {
        var retries = 0
        composeRule.setContent {
            LlamenosTheme { HubMembershipBanner(visible = true, onRetry = { retries++ }) }
        }
        val title = ApplicationProvider.getApplicationContext<Application>()
            .getString(R.string.hubs_membership_load_failed_title)

        composeRule.onNodeWithTag("hub-membership-error-banner").assertIsDisplayed()
        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithTag("hub-membership-error-retry").performClick()

        assertEquals(1, retries)
    }

    @Test
    fun `nothing is shown when the hub list is not known to have failed`() {
        composeRule.setContent {
            LlamenosTheme { HubMembershipBanner(visible = false, onRetry = {}) }
        }

        composeRule.onNodeWithTag("hub-membership-error-banner").assertDoesNotExist()
    }
}
