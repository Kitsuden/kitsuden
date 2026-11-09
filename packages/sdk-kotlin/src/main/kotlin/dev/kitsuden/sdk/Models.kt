package dev.kitsuden.sdk

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A dataset (a typed collection). [schema] is its field definition, as JSON. */
data class Dataset(
    val id: String,
    val name: String,
    val slug: String,
    val description: String?,
    val schema: JsonElement?,
    val createdAt: String?,
    val updatedAt: String?,
) {
    companion object {
        fun from(json: JsonElement): Dataset {
            val o = json.jsonObject
            return Dataset(
                id = o.string("id") ?: throw KitsudenDecodeException("dataset without id"),
                name = o.string("name") ?: "",
                slug = o.string("slug") ?: "",
                description = o.string("description"),
                schema = o["schema"],
                createdAt = o.string("createdAt"),
                updatedAt = o.string("updatedAt"),
            )
        }
    }
}

/** One entry of a dataset. [data] holds the fields the dataset schema defines. */
data class Entry(
    val id: String,
    val dataSetId: String,
    val title: String?,
    val data: JsonObject,
    val status: String?,
    val sortOrder: Double?,
    val ownerId: String?,
    val createdAt: String?,
    val updatedAt: String?,
) {
    companion object {
        fun from(json: JsonElement): Entry {
            val o = json.jsonObject
            return Entry(
                id = o.string("id") ?: throw KitsudenDecodeException("entry without id"),
                dataSetId = o.string("dataSetId") ?: "",
                title = o.string("title"),
                data = (o["data"] as? JsonObject) ?: JsonObject(emptyMap()),
                status = o.string("status"),
                sortOrder = (o["sortOrder"] as? JsonPrimitive)?.doubleOrNull,
                ownerId = o.string("ownerId"),
                createdAt = o.string("createdAt"),
                updatedAt = o.string("updatedAt"),
            )
        }
    }
}

/**
 * The body of an entry write. [title] and [data] are for everyone; [status] and
 * [sortOrder] are staff-only and are rejected for other callers. Nulls are not sent.
 */
data class EntryInput(
    val title: String? = null,
    val data: JsonObject? = null,
    val status: String? = null,
    val sortOrder: Double? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        title?.let { put("title", JsonPrimitive(it)) }
        data?.let { put("data", it) }
        status?.let { put("status", JsonPrimitive(it)) }
        sortOrder?.let { put("sortOrder", JsonPrimitive(it)) }
    }
}

/**
 * A request held for human approval (HTTP 202, `KITSUDEN_E_APPROVAL_REQUIRED`).
 * Nothing ran. Do not resend it: poll [statusUrl] with the same credentials.
 */
data class Proposal(val id: String, val status: String, val statusUrl: String, val reason: String?)

/** What a write returns: done, or held for human approval. */
sealed class WriteResult<out T> {
    data class Done<T>(val value: T) : WriteResult<T>()
    data class PendingApproval(val proposal: Proposal) : WriteResult<Nothing>()

    /** The value, or null when the write waits for approval. */
    fun valueOrNull(): T? = (this as? Done<T>)?.value
}

internal fun JsonObject.string(key: String): String? =
    this[key]?.takeIf { it !is JsonNull }?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
