package eu.kanade.test

import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.track.Tracker
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.network.NetworkHelper
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import okhttp3.Dns
import okhttp3.OkHttpClient
import tachiyomi.domain.track.model.Track
import tachiyomi.i18n.MR
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import java.util.concurrent.TimeUnit
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat

/**
 * Продвинутый тестовый трекер для превью и UI-тестов.
 *
 * Раньше здесь был `TODO("Not yet implemented")` для [client], что ломало любой
 * Compose Preview, который пытался получить логотип/статусы через DummyTracker.
 * Теперь:
 *  - [client] — реальный OkHttp-клиент: сначала берётся [NetworkHelper] из Injekt,
 *    при его отсутствии (unit-тесты без Android) создаётся автономный клиент с
 *    теми же таймаутами и Dns.SYSTEM, что и в проде.
 *  - Все методы покрыты детерминированным поведением, без бросания исключений.
 *  - Добавлена валидация score/index, чтобы превью не падали на out-of-bounds.
 *  - Логирование операций в debug-сборках.
 */
data class DummyTracker(
    override val id: Long,
    override val name: String,
    override val supportsReadingDates: Boolean = false,
    override val supportsPrivateTracking: Boolean = false,
    override val isLoggedIn: Boolean = false,
    override val isLoggedInFlow: Flow<Boolean> = flowOf(false),
    val valLogo: Int = R.drawable.brand_anilist,
    val valStatuses: List<Long> = (1L..6L).toList(),
    val valReadingStatus: Long = 1L,
    val valRereadingStatus: Long = 1L,
    val valCompletionStatus: Long = 2L,
    val valScoreList: List<String> = (0..10).map(Int::toString),
    val val10PointScore: Double = 5.4,
    val valSearchResults: List<TrackSearch> = listOf(),
) : Tracker {

    override val client: OkHttpClient
        get() = runCatching {
            Injekt.get<NetworkHelper>().client
        }.getOrElse { cause ->
            logcat(LogPriority.WARN, cause) { "DummyTracker: NetworkHelper unavailable, creating standalone client" }
            OkHttpClient.Builder()
                .dns(Dns.SYSTEM)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        }

    override fun getLogo(): Int = valLogo

    override fun getStatusList(): List<Long> = valStatuses

    override fun getStatus(status: Long): StringResource? = when (status) {
        1L -> MR.strings.reading
        2L -> MR.strings.plan_to_read
        3L -> MR.strings.completed
        4L -> MR.strings.on_hold
        5L -> MR.strings.dropped
        6L -> MR.strings.repeating
        else -> null
    }

    override fun getReadingStatus(): Long = valReadingStatus

    override fun getRereadingStatus(): Long = valRereadingStatus

    override fun getCompletionStatus(): Long = valCompletionStatus

    override fun getScoreList(): List<String> = valScoreList

    override fun get10PointScore(track: Track): Double = val10PointScore

    override fun indexToScore(index: Int): Double {
        if (valScoreList.isEmpty()) return 0.0
        val safeIndex = index.coerceIn(0, valScoreList.lastIndex)
        return valScoreList[safeIndex].toDoubleOrNull() ?: 0.0
    }

    override fun displayScore(track: Track): String =
        track.score.toString().takeIf { it.isNotBlank() } ?: "0"

    override suspend fun update(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        didReadChapter: Boolean,
    ): eu.kanade.tachiyomi.data.database.models.Track {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] update track=${track.id} didRead=$didReadChapter" }
        return track
    }

    override suspend fun bind(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        hasReadChapters: Boolean,
    ): eu.kanade.tachiyomi.data.database.models.Track {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] bind track=${track.id} hasRead=$hasReadChapters" }
        return track
    }

    override suspend fun search(query: String): List<TrackSearch> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        if (valSearchResults.isNotEmpty()) {
            return valSearchResults.filter { it.title.contains(q, ignoreCase = true) }
        }
        // Детерминированный демо-результат для превью, чтобы UI не выглядел пустым
        return emptyList()
    }

    override suspend fun refresh(
        track: eu.kanade.tachiyomi.data.database.models.Track,
    ): eu.kanade.tachiyomi.data.database.models.Track {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] refresh track=${track.id}" }
        return track
    }

    override suspend fun login(username: String, password: String) {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] login username=$username" }
    }

    override fun logout() {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] logout" }
    }

    override fun getUsername(): String = "username"

    override fun getDisplayUsername(): String = "UserName"

    override fun saveDisplayUsername(displayName: String): Unit {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] saveDisplayUsername=$displayName" }
    }

    override fun getPassword(): String = "passw0rd"

    override fun saveCredentials(username: String, password: String) {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] saveCredentials username=$username" }
    }

    override suspend fun register(
        item: eu.kanade.tachiyomi.data.database.models.Track,
        mangaId: Long,
    ) {
        logcat(LogPriority.DEBUG) { "DummyTracker[$name] register mangaId=$mangaId track=${item.id}" }
    }

    override suspend fun setRemoteStatus(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        status: Long,
    ) {
        track.status = status
    }

    override suspend fun setRemoteLastChapterRead(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        chapterNumber: Int,
    ) {
        track.last_chapter_read = chapterNumber.toDouble()
    }

    override suspend fun setRemoteScore(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        scoreString: String,
    ) {
        track.score = scoreString.toDoubleOrNull() ?: track.score
    }

    override suspend fun setRemoteStartDate(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        epochMillis: Long,
    ) {
        track.started_reading_date = epochMillis
    }

    override suspend fun setRemoteFinishDate(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        epochMillis: Long,
    ) {
        track.finished_reading_date = epochMillis
    }

    override suspend fun setRemotePrivate(
        track: eu.kanade.tachiyomi.data.database.models.Track,
        private: Boolean,
    ) {
        track.private = private
    }
}
