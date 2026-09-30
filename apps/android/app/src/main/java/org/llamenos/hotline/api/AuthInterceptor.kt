package org.llamenos.hotline.api

import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.llamenos.hotline.crypto.CryptoService
import javax.inject.Inject
import javax.inject.Singleton

/**
 * OkHttp [Interceptor] that injects Ed25519-signed authentication tokens into every request.
 *
 * The Authorization header contains a Bearer token with a JSON payload:
 * ```
 * Authorization: Bearer {"pubkey":"<hex>","timestamp":<ms>,"token":"<ed25519_sig>"}
 * ```
 *
 * The token is created synchronously via [CryptoService.createAuthTokenSync] because
 * OkHttp interceptors execute on OkHttp's thread pool and cannot use coroutines.
 * Ed25519 signing is ~1ms so blocking the calling thread is acceptable.
 *
 * Thread safety: The interceptor synchronizes on [cryptoService] to prevent a race
 * between the `isUnlocked` check and token creation if `lock()` is called concurrently
 * (e.g., from the background timeout handler on the main thread).
 *
 * Security: If authentication fails (key locked or signing error), a synthetic 401
 * response is returned immediately instead of dispatching an unauthenticated request.
 * This prevents unauthenticated requests from reaching the server.
 * The only exception is a request tagged [UnsignedRequest] (public endpoints).
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val cryptoService: CryptoService,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        if (originalRequest.tag(UnsignedRequest::class.java) != null) {
            return chain.proceed(originalRequest)
        }
        val method = originalRequest.method
        val path = originalRequest.url.encodedPath

        val authenticatedRequest = synchronized(cryptoService) {
            if (!cryptoService.isUnlocked) {
                return@synchronized null
            }

            try {
                val token = cryptoService.createAuthTokenSync(method, path)
                val authHeaderValue = buildString {
                    append("""{"pubkey":"""")
                    append(token.pubkey)
                    append("""","timestamp":""")
                    append(token.timestamp)
                    append(""","token":"""")
                    append(token.token)
                    append('"')
                    if (token.nonce != null) {
                        append(""","nonce":"""")
                        append(token.nonce)
                        append('"')
                    }
                    append('}')
                }

                originalRequest.newBuilder()
                    .header("Authorization", "Bearer $authHeaderValue")
                    .build()
            } catch (_: Exception) {
                // Key was locked between the isUnlocked check and the signing call.
                null
            }
        }

        if (authenticatedRequest == null) {
            // Return synthetic 401 instead of dispatching an unauthenticated request.
            // The app's error handling will redirect to the unlock screen.
            return Response.Builder()
                .code(401)
                .message("Authentication failed")
                .protocol(Protocol.HTTP_1_1)
                .request(originalRequest)
                .body("".toResponseBody(null))
                .build()
        }

        return chain.proceed(authenticatedRequest)
    }
}
