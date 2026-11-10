package org.llamenos.hotline.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.ui.auth.AuthViewModel

/**
 * Routes that are shown while the device keys are locked (or before they exist). Every
 * other route shows unlocked content and is left as soon as the keys are dropped.
 */
internal val AUTH_ROUTES = setOf(
    LlamenosRoute.Login.route,
    LlamenosRoute.Onboarding.route,
    LlamenosRoute.PINSet.route,
    LlamenosRoute.PINUnlock.route,
    LlamenosRoute.InviteRedeem.route,
)

/**
 * Follows [CryptoService.unlockedState]: whatever dropped the device keys — the Lock
 * button, Settings → Lock, the background auto-lock in `MainActivity.onStart` (#1535) —
 * the unlocked screens go with them (#1339). The authenticated flag is cleared first
 * ([AuthViewModel.onLocked]) so the PIN unlock screen does not treat the just-locked
 * session as authenticated and bounce straight back to Main.
 *
 * Logout navigates to Login itself and is already there by the time this runs. An auth
 * route is left alone: locking while already on the unlock screen (or mid-enrolment)
 * must not stack a second copy of it.
 */
@Composable
fun SessionLockEffect(
    navController: NavHostController,
    cryptoService: CryptoService,
    authViewModel: AuthViewModel,
    keystoreService: KeystoreService,
) {
    LaunchedEffect(navController) {
        cryptoService.unlockedState.collect { unlocked ->
            val route = navController.currentDestination?.route ?: return@collect
            if (unlocked || route in AUTH_ROUTES) return@collect
            authViewModel.onLocked()
            val target = if (keystoreService.contains(KeystoreService.KEY_ENCRYPTED_KEYS)) {
                LlamenosRoute.PINUnlock.route
            } else {
                LlamenosRoute.Login.route
            }
            navController.navigate(target) { popUpTo(0) { inclusive = true } }
        }
    }
}
