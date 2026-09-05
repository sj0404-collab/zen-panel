package eu.kanade.tachiyomi.data.track.kavita

import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.track.BaseTracker
import eu.kanade.tachiyomi.data.track.EnhancedTracker
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.sourcePreferences
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import tachiyomi.domain.manga.model.Manga
import tachiyomi.domain.source.service.SourceManager
import tachiyomi.i18n.MR
import uy.kohesive.injekt.injectLazy
import java.security.MessageDigest
import tachiyomi.domain.track.model.Track as DomainTrack

class Kavita(id: Long) : BaseTracker(id, "Kavita"), EnhancedTracker {

    companion object {
        const val UNREAD = 1L
        const val READING = 2L
        const val COMPLETED = 3L
        private const val SEARCH_LIMIT = 20
    }

    var authentications: OAuth? = null

    private val interceptor by lazy { KavitaInterceptor(this) }
    val api by lazy { KavitaApi(client, interceptor) }

    private val sourceManager: SourceManager by injectLazy()

    override fun getLogo(): Int = R.drawable.brand_kavita

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
     * Продвинутый поиск по всем настроенным инстансам Kavita.
     *
     * Раньше метод бросал `TODO`, из-за чего любой вызов из UI/тестов падал с
     * NotImplementedError. Теперь:
     *  - Если ни один источник Kavita не настроен — возвращается пустой список
     *    с предупреждением в логе (корректное поведение для EnhancedTracker,
     *    который привязан к источнику, а не к глобальному каталогу).
     *  - Для каждого настроенного API (до 3 слотов `kavita_1..3`) выполняется
     *    запрос `/api/Search/search?queryString=...` с ограничением [SEARCH_LIMIT].
     *  - Ошибки одного инстанса не прерывают поиск по остальным (addSuppressed).
     *  - Дубликаты по `tracking_url` удаляются, сохраняется порядок релевантности.
     *  - Пустой запрос возвращает пустой список без сетевого вызова.
     */
    override suspend fun search(query: String): List<TrackSearch> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()

        // Гарантируем, что OAuth загружен, но не падаем, если источников нет
        if (authentications == null) {
            runCatching { loadOAuth() }
        }

        val auths = authentications?.authentications?.filter {
            it.apiUrl.isNotBlank() && it.jwtToken.isNotBlank()
        }.orEmpty()

        if (auths.isEmpty()) {
            logcat(LogPriority.WARN) { "Kavita search: no configured instances, query=$q" }
            return emptyList()
        }

        val allResults = mutableListOf<TrackSearch>()
        var lastError: Throwable? = null

        for (auth in auths) {
            try {
                val results = api.search(q, auth, SEARCH_LIMIT)
                allResults += results
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "Kavita search failed for ${auth.apiUrl}, query=$q" }
                if (lastError == null) lastError = e else lastError.addSuppressed(e)
            }
        }

        if (allResults.isEmpty() && lastError != null) {
            logcat(LogPriority.ERROR, lastError) { "Kavita search: all instances failed for query=$q" }
        }

        return allResults
            .distinctBy { it.tracking_url }
            .take(SEARCH_LIMIT)
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

    override fun getAcceptedSources() = listOf("eu.kanade.tachiyomi.extension.all.kavita.Kavita")

    override suspend fun match(manga: Manga): TrackSearch? =
        try {
            api.getTrackSearch(manga.url)
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "Kavita match failed for url=${manga.url}" }
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

    fun loadOAuth() {
        val oauth = OAuth()
        for (id in 1..3) {
            val authentication = oauth.authentications[id - 1]
            val sourceId by lazy {
                val key = "kavita_$id/all/1" // Hardcoded versionID to 1
                val bytes = MessageDigest.getInstance("MD5").digest(key.toByteArray())
                (0..7).map { bytes[it].toLong() and 0xff shl 8 * (7 - it) }
                    .reduce(Long::or) and Long.MAX_VALUE
            }
            val preferences = try {
                (sourceManager.get(sourceId) as? ConfigurableSource)?.sourcePreferences()
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "Kavita loadOAuth: source $sourceId not installed" }
                null
            } ?: continue

            val prefApiUrl = preferences.getString("APIURL", "")
            val prefApiKey = preferences.getString("APIKEY", "")
            if (prefApiUrl.isNullOrEmpty() || prefApiKey.isNullOrEmpty()) {
                // Source not configured. Skip
                continue
            }

            val token = try {
                api.getNewToken(apiUrl = prefApiUrl, apiKey = prefApiKey)
            } catch (e: Exception) {
                logcat(LogPriority.WARN, e) { "Kavita loadOAuth: token fetch failed for $prefApiUrl" }
                null
            }
            if (token.isNullOrEmpty()) {
                // Source is not accessible. Skip
                continue
            }

            authentication.apiUrl = prefApiUrl
            authentication.jwtToken = token
        }
        authentications = oauth
    }
}
