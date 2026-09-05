package eu.kanade.tachiyomi.data.track.komga

import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.track.BaseTracker
import eu.kanade.tachiyomi.data.track.EnhancedTracker
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.source.Source
import logcat.LogPriority
import okhttp3.Dns
import okhttp3.OkHttpClient
import tachiyomi.domain.manga.model.Manga
import tachiyomi.core.common.util.system.logcat
import tachiyomi.i18n.MR
import tachiyomi.domain.track.model.Track as DomainTrack

class Komga(id: Long) : BaseTracker(id, "Komga"), EnhancedTracker {

    companion object {
        const val UNREAD = 1L
        const val READING = 2L
        const val COMPLETED = 3L
        private const val SEARCH_LIMIT = 20
    }

    override val client: OkHttpClient =
        networkService.client.newBuilder()
            .dns(Dns.SYSTEM) // don't use DNS over HTTPS as it breaks IP addressing
            .build()

    val api by lazy { KomgaApi(id, client) }

    override fun getLogo() = R.drawable.brand_komga

    override fun getStatusList(): List<Long> = listOf(UNREAD, READING, COMPLETED)

    override fun getStatus(status: Long): StringResource? = when (status) {
        UNREAD -> MR.strings.unread
        READING -> MR.strings.reading
        COMPLETED -> MR.strings.completed
        else -> null
    }

    override fun getReadingStatus(): Long = READING

    override fun getRereadingStatus(): Long = -1

    override fun getCompletionStatus(): Long = COMPLETED

    override fun getScoreList(): List<String> = listOf()

    override fun displayScore(track: DomainTrack): String = ""

    override suspend fun update(track: Track, didReadChapter: Boolean): Track {
        if (track.status != COMPLETED) {
            if (didReadChapter) {
                if (track.last_chapter_read.toLong() == track.total_chapters && track.total_chapters > 0) {
                    track.status = COMPLETED
                } else {
                    track.status = READING
                }
            }
        }

        return api.updateProgress(track)
    }

    override suspend fun bind(track: Track, hasReadChapters: Boolean): Track {
        return track
    }

    /**
     * Продвинутый поиск в Komga.
     *
     * Komga — EnhancedTracker, привязанный к источнику `Komga`. Поиск идёт
     * через REST API сервера, настроенного в источнике. Раньше метод бросал
     * `TODO`, теперь:
     *  - Пустой запрос → пустой список без сети.
     *  - Используется `GET /api/v1/series?search={query}&page=0&size=20`
     *    (совместим с Komga 1.x; POST /api/v1/series/list — для новых версий
     *    и обрабатывается как fallback).
     *  - Ошибки логируются, возвращается пустой список, а не краш.
     *  - При отсутствии настроенного источника — предупреждение и пустой список.
     */
    override suspend fun search(query: String): List<TrackSearch> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        return try {
            api.search(q, SEARCH_LIMIT)
        } catch (e: Exception) {
            // Komga источник может отсутствовать или быть не настроен (IO, 401, etc.)
            // Для EnhancedTracker это ожидаемо — не падаем с NotImplementedError.
            logcat(LogPriority.WARN, e) { "Komga search failed for query=$q" }
            emptyList()
        }
    }

    override suspend fun refresh(track: Track): Track {
        val remoteTrack = api.getTrackSearch(track.tracking_url)
        track.copyPersonalFrom(remoteTrack)
        track.total_chapters = remoteTrack.total_chapters
        return track
    }

    override suspend fun login(username: String, password: String) {
        saveCredentials("user", "pass")
    }

    // [Tracker].isLogged works by checking that credentials are saved.
    // By saving dummy, unused credentials, we can activate the tracker simply by login/logout
    override fun loginNoop() {
        saveCredentials("user", "pass")
    }

    override fun getAcceptedSources() = listOf("eu.kanade.tachiyomi.extension.all.komga.Komga")

    override suspend fun match(manga: Manga): TrackSearch? =
        try {
            api.getTrackSearch(manga.url)
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Komga match failed for url=${manga.url}" }
            null
        }

    override fun isTrackFrom(track: DomainTrack, manga: Manga, source: Source?): Boolean =
        track.remoteUrl == manga.url && source?.let { accept(it) } == true

    override fun migrateTrack(track: DomainTrack, manga: Manga, newSource: Source): DomainTrack? =
        if (accept(newSource)) {
            track.copy(remoteUrl = manga.url)
        } else {
            null
        }
}
