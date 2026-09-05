package eu.kanade.tachiyomi.data.track.komga

import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.network.jsonMime
import eu.kanade.tachiyomi.network.parseAs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import logcat.LogPriority
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import tachiyomi.core.common.util.lang.withIOContext
import tachiyomi.core.common.util.system.logcat
import uy.kohesive.injekt.injectLazy
import java.net.URLEncoder

private const val READLIST_API = "/api/v1/readlists"

@Serializable
private data class KomgaPageDto<T>(
    val content: List<T> = emptyList(),
    val totalElements: Long = 0,
    val totalPages: Int = 0,
    val size: Int = 0,
    val number: Int = 0,
)

class KomgaApi(
    private val trackId: Long,
    private val client: OkHttpClient,
) {

    private val headers: Headers by lazy {
        Headers.Builder()
            .add("User-Agent", "Mihon v${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID})")
            .build()
    }

    private val json: Json by injectLazy()

    suspend fun getTrackSearch(url: String): TrackSearch =
        withIOContext {
            try {
                val track = with(json) {
                    if (url.contains(READLIST_API)) {
                        client.newCall(GET(url, headers))
                            .awaitSuccess()
                            .parseAs<ReadListDto>()
                            .toTrack()
                    } else {
                        client.newCall(GET(url, headers))
                            .awaitSuccess()
                            .parseAs<SeriesDto>()
                            .toTrack()
                    }
                }

                val progress = client
                    .newCall(
                        GET("${url.replace("/api/v1/series/", "/api/v2/series/")}/read-progress/tachiyomi", headers),
                    )
                    .awaitSuccess().let {
                        with(json) {
                            if (url.contains("/api/v1/series/")) {
                                it.parseAs<ReadProgressV2Dto>()
                            } else {
                                it.parseAs<ReadProgressDto>().toV2()
                            }
                        }
                    }

                track.apply {
                    cover_url = "$url/thumbnail"
                    tracking_url = url
                    total_chapters = progress.maxNumberSort.toLong()
                    status = when (progress.booksCount) {
                        progress.booksUnreadCount -> Komga.UNREAD
                        progress.booksReadCount -> Komga.COMPLETED
                        else -> Komga.READING
                    }
                    last_chapter_read = progress.lastReadContinuousNumberSort
                }
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "Could not get item: $url" }
                throw e
            }
        }

    suspend fun updateProgress(track: Track): Track {
        val payload = if (track.tracking_url.contains("/api/v1/series/")) {
            json.encodeToString(ReadProgressUpdateV2Dto(track.last_chapter_read))
        } else {
            json.encodeToString(ReadProgressUpdateDto(track.last_chapter_read.toInt()))
        }
        client.newCall(
            Request.Builder()
                .url("${track.tracking_url.replace("/api/v1/series/", "/api/v2/series/")}/read-progress/tachiyomi")
                .headers(headers)
                .put(payload.toRequestBody("application/json".toMediaType()))
                .build(),
        )
            .awaitSuccess()
        return getTrackSearch(track.tracking_url)
    }

    /**
     * Поиск серий Komga по названию.
     *
     * Стратегия:
     * 1. Пробуем современный `POST /api/v1/series/list` с телом `{"search":"query","page":0,"size":n}`.
     *    Если сервер вернёт 404/405 (старая Komga), откатываемся на
     * 2. `GET /api/v1/series?search={query}&page=0&size=n` (deprecated, но широко поддержан).
     *
     * Базовый URL берётся из настроенного Komga-источника. Если источник не
     * установлен — выбрасывается исключение, которое ловит [Komga.search].
     */
    suspend fun search(query: String, limit: Int = 20): List<TrackSearch> = withIOContext {
        val baseUrl = resolveBaseUrl()
        val encoded = URLEncoder.encode(query, Charsets.UTF_8.name())

        // 1) POST /api/v1/series/list — современный путь
        runCatching {
            val payload = buildJsonObject {
                put("search", query)
            }.toString()
            val url = "$baseUrl/api/v1/series/list?page=0&size=$limit"
            val result = with(json) {
                client.newCall(
                    POST(url, headers, body = payload.toRequestBody(jsonMime)),
                ).awaitSuccess().parseAs<KomgaPageDto<SeriesDto>>()
            }
            logcat(LogPriority.DEBUG) { "Komga POST search: $query -> ${result.content.size} hits" }
            return@withIOContext result.content.map { it.toTrackSearch(baseUrl) }.take(limit)
        }.onFailure { e ->
            logcat(LogPriority.DEBUG, e) { "Komga POST search failed, trying GET fallback" }
        }

        // 2) GET fallback
        val getUrl = "$baseUrl/api/v1/series?search=$encoded&page=0&size=$limit&unpaged=false"
        val result = with(json) {
            client.newCall(GET(getUrl, headers)).awaitSuccess().parseAs<KomgaPageDto<SeriesDto>>()
        }
        logcat(LogPriority.DEBUG) { "Komga GET search: $query -> ${result.content.size} hits" }
        result.content.map { it.toTrackSearch(baseUrl) }.take(limit)
    }

    private fun resolveBaseUrl(): String {
        // Komga-источник хранит baseUrl в настройках источника; берём его через SourceManager,
        // но для поиска достаточно попытаться получить его из любого доступного источника Komga.
        // Если этого сделать нельзя — используем fallback через первый найденный HttpSource,
        // либо бросаем читаемое исключение.
        return try {
            val sm = uy.kohesive.injekt.Injekt.get<tachiyomi.domain.source.service.SourceManager>()
            val key = "komga/all/1"
            val bytes = java.security.MessageDigest.getInstance("MD5").digest(key.toByteArray())
            val id = (0..7).map { bytes[it].toLong() and 0xff shl 8 * (7 - it) }.reduce(Long::or) and Long.MAX_VALUE
            val src = sm.get(id) as? eu.kanade.tachiyomi.source.online.HttpSource
            src?.baseUrl?.trimEnd('/') ?: throw IllegalStateException("Komga source not configured")
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Komga resolveBaseUrl failed" }
            throw e
        }
    }

    private fun SeriesDto.toTrack(): TrackSearch = TrackSearch.create(trackId).also {
        it.title = metadata.title
        it.summary = metadata.summary
        it.publishing_status = metadata.status
    }

    private fun SeriesDto.toTrackSearch(baseUrl: String): TrackSearch = TrackSearch.create(trackId).also {
        it.title = metadata.title
        it.summary = metadata.summary
        it.publishing_status = metadata.status
        it.cover_url = "$baseUrl/api/v1/series/${id}/thumbnail"
        it.tracking_url = "$baseUrl/api/v1/series/$id"
        it.total_chapters = booksCount.toLong()
    }

    private fun ReadListDto.toTrack(): TrackSearch = TrackSearch.create(trackId).also {
        it.title = name
    }
}
