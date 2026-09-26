package org.llamenos.hotline.di

import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.UserIdentityService
import org.llamenos.hotline.hub.ActiveHubState

/**
 * Hilt entry points for accessing singletons from non-injected code.
 *
 * These are used by:
 * - Instrumentation test hooks (ScenarioHooks) to set the active hub
 * - Test step definitions to read the signing pubkey for admin promotion
 *
 * Entry points are defined in main source (not androidTest) because the
 * production Dagger component must implement them. @EntryPoint interfaces
 * in androidTest are not compiled into the production component by KSP.
 */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface ActiveHubEntryPoint {
    fun activeHubState(): ActiveHubState
}

@EntryPoint
@InstallIn(SingletonComponent::class)
interface CryptoEntryPoint {
    fun cryptoService(): CryptoService
}

@EntryPoint
@InstallIn(SingletonComponent::class)
interface UserIdentityEntryPoint {
    fun userIdentityService(): UserIdentityService
    fun apiService(): ApiService
}
