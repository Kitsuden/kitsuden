package dev.kitsuden.sdk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Anything the client throws. */
sealed class KitsudenException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * An `/api/*` error. Every one is `application/problem+json` (RFC 9457) with a stable
 * [code] (`KITSUDEN_E_*`): branch on it, never on the message. [retryable] says whether
 * the SAME request may succeed if repeated; [retryAfter] how many seconds to wait first.
 */
class KitsudenApiException(
    val status: Int,
    val code: String,
    val title: String?,
    val detail: String?,
    val hint: String?,
    val retryable: Boolean,
    val retryAfter: Double?,
    val requestId: String?,
) : KitsudenException(buildString {
    append("$code (HTTP $status)")
    if (detail != null) append(": $detail")
    if (hint != null) append(" — $hint")
}) {
    companion object {
        /** Retryable even without a problem body (a proxy's error page). */
        private val RETRYABLE_STATUSES = setOf(408, 429, 502, 503, 504)

        fun fromResponse(status: Int, body: String, retryAfterHeader: String?): KitsudenApiException {
            val headerWait = retryAfterHeader?.trim()?.toDoubleOrNull()
            val problem = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
            fun text(key: String) = problem?.get(key)?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
            return KitsudenApiException(
                status = status,
                code = text("code") ?: fallbackCode(status),
                title = text("title"),
                detail = text("detail") ?: text("error"),
                hint = text("hint"),
                retryable = problem?.get("retryable")?.let { runCatching { it.jsonPrimitive.booleanOrNull }.getOrNull() }
                    ?: (status in RETRYABLE_STATUSES),
                retryAfter = problem?.get("retry_after")?.let { runCatching { it.jsonPrimitive.doubleOrNull }.getOrNull() }
                    ?: headerWait,
                requestId = text("requestId"),
            )
        }

        fun fallbackCode(status: Int): String = when (status) {
            400 -> "KITSUDEN_E_BAD_REQUEST"
            401 -> "KITSUDEN_E_UNAUTHENTICATED"
            403 -> "KITSUDEN_E_FORBIDDEN"
            404 -> "KITSUDEN_E_NOT_FOUND"
            409 -> "KITSUDEN_E_CONFLICT"
            413 -> "KITSUDEN_E_PAYLOAD_TOO_LARGE"
            422 -> "KITSUDEN_E_VALIDATION"
            429 -> "KITSUDEN_E_RATE_LIMITED"
            502 -> "KITSUDEN_E_BAD_GATEWAY"
            503 -> "KITSUDEN_E_UNAVAILABLE"
            504 -> "KITSUDEN_E_TIMEOUT"
            else -> "KITSUDEN_E_INTERNAL"
        }
    }
}

/** No HTTP response (offline, DNS, timeout). */
class KitsudenNetworkException(message: String, cause: Throwable? = null) : KitsudenException(message, cause)

/** A success body that is not the JSON the operation promises. */
class KitsudenDecodeException(message: String, cause: Throwable? = null) : KitsudenException(message, cause)
