package org.llamenos.hotline.di

import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import org.llamenos.hotline.crypto.BiometricKeyStore
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.UserIdentityInitializer
import org.llamenos.hotline.crypto.UserIdentityService
import javax.inject.Singleton

/**
 * Hilt dependency injection module for the llamenos application.
 *
 * All core services use constructor injection (`@Inject constructor`) and
 * are annotated with `@Singleton`, so Hilt binds them automatically.
 * This module exists as the extension point for any future `@Provides`
 * methods that require custom construction logic (e.g., configuring
 * OkHttpClient with certificates, database instances).
 *
 * Automatically-bound singletons (via @Inject constructor + @Singleton):
 *
 *   CryptoService       (no deps)
 *   KeystoreService     (@ApplicationContext Context) -> KeyValueStore
 *   WakeKeyService      (KeystoreService)
 *   AuthInterceptor     (CryptoService)
 *   ApiService          (AuthInterceptor, KeyValueStore)
 *   WebSocketService    (CryptoService, KeyValueStore)
 *   UserIdentityService (CryptoService, ApiService) -> UserIdentityInitializer
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AppModule {

    @Binds
    @Singleton
    abstract fun bindKeyValueStore(keystoreService: KeystoreService): KeyValueStore

    @Binds
    @Singleton
    abstract fun bindBiometricKeyStore(keystoreService: KeystoreService): BiometricKeyStore

    @Binds
    @Singleton
    abstract fun bindUserIdentityInitializer(service: UserIdentityService): UserIdentityInitializer
}
