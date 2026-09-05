package tachiyomi.source.local

import android.content.Context
import com.hippo.unifile.UniFile
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.UnmeteredSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.SMangaUpdate
import eu.kanade.tachiyomi.util.lang.compareToCaseInsensitiveNaturalOrder
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.supervisorScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import logcat.LogPriority
import mihon.core.archive.archiveReader
import mihon.core.archive.epubReader
import nl.adaptivity.xmlutil.core.AndroidXmlReader
import nl.adaptivity.xmlutil.serialization.XML
import tachiyomi.core.common.i18n.stringResource
import tachiyomi.core.common.storage.extension
import tachiyomi.core.common.storage.nameWithoutExtension
import tachiyomi.core.common.util.lang.withIOContext
import tachiyomi.core.common.util.system.ImageUtil
import tachiyomi.core.common.util.system.logcat
import tachiyomi.core.metadata.comicinfo.COMIC_INFO_FILE
import tachiyomi.core.metadata.comicinfo.ComicInfo
import tachiyomi.core.metadata.comicinfo.copyFromComicInfo
import tachiyomi.core.metadata.comicinfo.getComicInfo
import tachiyomi.core.metadata.tachiyomi.MangaDetails
import tachiyomi.domain.chapter.service.ChapterRecognition
import tachiyomi.domain.library.model.LibraryIndex
import tachiyomi.domain.manga.model.Manga
import tachiyomi.i18n.MR
import tachiyomi.source.local.filter.GenreFilter
import tachiyomi.source.local.filter.OrderBy
import tachiyomi.source.local.image.LocalCoverManager
import tachiyomi.source.local.io.Archive
import tachiyomi.source.local.io.Format
import tachiyomi.source.local.io.LocalSourceFileSystem
import tachiyomi.source.local.metadata.fillMetadata
import uy.kohesive.injekt.injectLazy
import java.io.InputStream
import java.nio.charset.StandardCharsets
import kotlin.time.Duration.Companion.days
import tachiyomi.domain.source.model.Source as DomainSource

actual class LocalSource(
    private val context: Context,
    private val fileSystem: LocalSourceFileSystem,
    private val coverManager: LocalCoverManager,
) : Source, UnmeteredSource {

    private val json: Json by injectLazy()
    private val xml: XML by injectLazy()

    /** Кэш «имя манги -> жанры из ComicInfo.xml» + общий отсортированный список. */
    private val genreCache = java.util.concurrent.ConcurrentHashMap<String, List<String>>()

    private fun genresOf(mangaDir: UniFile): List<String> {
        val key = mangaDir.name.orEmpty()
        genreCache[key]?.let { return it }
        val genres = runCatching {
            if (!mangaDir.isDirectory) return@runCatching emptyList()
            val comicInfo = mangaDir.listFiles().orEmpty()
                .firstOrNull { it.name == COMIC_INFO_FILE } ?: return@runCatching emptyList()
            val text = comicInfo.openInputStream().bufferedReader().use { it.readText() }
            Regex("<Genre>(.*?)</Genre>", RegexOption.DOT_MATCHES_ALL)
                .find(text)
                ?.groupValues?.get(1)
                ?.split(',', ';')
                ?.map { it.trim() }
                ?.filter { it.isNotBlank() }
                .orEmpty()
        }.getOrDefault(emptyList())
        genreCache[key] = genres
        return genres
    }

    private fun allKnownGenres(): List<String> {
        // Прогреваем кэш по всем мангам (быстро: только ComicInfo.xml корня)
        fileSystem.getFilesInBaseDirectory()
            .filter { it.isDirectory }
            .forEach { genresOf(it) }
        return genreCache.values.flatten().distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)
    }

    @Suppress("PrivatePropertyName")
    private val PopularFilters = FilterList(OrderBy.Popular(context))

    @Suppress("PrivatePropertyName")
    private val LatestFilters = FilterList(OrderBy.Latest(context))

    override val name: String = context.stringResource(MR.strings.local_source)

    override val id: Long = ID

    override val lang: String = "other"

    override fun toString() = name

    override val supportsLatest: Boolean = true

    // Browse related
    override suspend fun getPopularManga(page: Int) = getSearchManga(page, "", PopularFilters)

    override suspend fun getLatestUpdates(page: Int) = getSearchManga(page, "", LatestFilters)

    override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage = withIOContext {
        val lastModifiedLimit = if (filters === LatestFilters) {
            System.currentTimeMillis() - LATEST_THRESHOLD
        } else {
            0L
        }

        var mangaDirs = fileSystem.getFilesInBaseDirectory()
            // Папки-манги И одиночные архивы CBZ/CBR/ZIP (как в CDisplayEx)
            .filter { (it.isDirectory || Archive.isSupported(it)) && !it.name.orEmpty().startsWith('.') }
            .distinctBy { it.name }
            .filter {
                if (lastModifiedLimit == 0L && query.isBlank()) {
                    true
                } else if (lastModifiedLimit == 0L) {
                    // Обычный запрос — поиск по подстроке, запрос с маркером «#»
                    // — алфавитный указатель (см. LibraryIndex). Разбор живёт в
                    // domain и покрыт юнит-тестами.
                    LibraryIndex.matches(it.name.orEmpty(), query)
                } else {
                    it.lastModified() >= lastModifiedLimit
                }
            }

        filters.forEach { filter ->
            when (filter) {
                is GenreFilter -> {
                    val genre = filter.selectedGenre
                    if (genre != null) {
                        mangaDirs = mangaDirs.filter { dir ->
                            genresOf(dir).any { it.equals(genre, ignoreCase = true) }
                        }
                    }
                }
                is OrderBy.Popular -> {
                    mangaDirs = if (filter.state!!.ascending) {
                        mangaDirs.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name.orEmpty() })
                    } else {
                        mangaDirs.sortedWith(compareByDescending(String.CASE_INSENSITIVE_ORDER) { it.name.orEmpty() })
                    }
                }
                is OrderBy.Latest -> {
                    mangaDirs = if (filter.state!!.ascending) {
                        mangaDirs.sortedBy(UniFile::lastModified)
                    } else {
                        mangaDirs.sortedByDescending(UniFile::lastModified)
                    }
                }
                else -> {
                    /* Do nothing */
                }
            }
        }

        val mangas = mangaDirs
            .map { mangaDir ->
                async {
                    SManga.create().apply {
                        title = if (mangaDir.isDirectory) {
                            mangaDir.name.orEmpty()
                        } else {
                            mangaDir.nameWithoutExtension.orEmpty()
                        }
                        url = mangaDir.name.orEmpty()

                        // Обложка: ТОЛЬКО из кэша — листинг каталога мгновенный.
                        // Отсутствующие обложки генерируются в фоне по одной
                        // (см. scheduleCoverGeneration) и появляются при
                        // следующей перерисовке, не блокируя UI.
                        val cover = coverManager.find(mangaDir.name.orEmpty())
                        if (cover != null) {
                            thumbnail_url = cover.uri.toString()
                        } else {
                            scheduleCoverGeneration(mangaDir, this)
                        }
                    }
                }
            }
            .awaitAll()

        MangasPage(mangas, false)
    }

    override suspend fun getMangaUpdate(
        manga: SManga,
        chapters: List<SChapter>,
        fetchDetails: Boolean,
        fetchChapters: Boolean,
    ): SMangaUpdate = supervisorScope {
        val asyncManga = if (fetchDetails) async { getMangaDetails(manga) } else null
        val asyncChapters = if (fetchChapters) async { getChapterList(manga) } else null
        SMangaUpdate(asyncManga?.await() ?: manga, asyncChapters?.await() ?: chapters)
    }

    // Manga details related
    private suspend fun getMangaDetails(manga: SManga): SManga = withIOContext {
        coverManager.find(manga.url)?.let {
            manga.thumbnail_url = it.uri.toString()
        }

        // Augment manga details based on metadata files
        try {
            val mangaDir = fileSystem.getMangaDirectory(manga.url) ?: error("${manga.url} is not a valid directory")
            val mangaDirFiles = mangaDir.listFiles().orEmpty()

            val comicInfoFile = mangaDirFiles
                .firstOrNull { it.name == COMIC_INFO_FILE }
            val noXmlFile = mangaDirFiles
                .firstOrNull { it.name == ".noxml" }
            val legacyJsonDetailsFile = mangaDirFiles
                .firstOrNull { it.extension == "json" }

            when {
                // Top level ComicInfo.xml
                comicInfoFile != null -> {
                    noXmlFile?.delete()
                    setMangaDetailsFromComicInfoFile(comicInfoFile.openInputStream(), manga)
                }

                // Old custom JSON format
                // TODO: remove support for this entirely after a while
                legacyJsonDetailsFile != null -> {
                    json.decodeFromStream<MangaDetails>(legacyJsonDetailsFile.openInputStream()).run {
                        title?.let { manga.title = it }
                        author?.let { manga.author = it }
                        artist?.let { manga.artist = it }
                        description?.let { manga.description = it }
                        genre?.let { manga.genre = it.joinToString() }
                        status?.let { manga.status = it }
                    }
                    // Replace with ComicInfo.xml file
                    val comicInfo = manga.getComicInfo()
                    mangaDir
                        .createFile(COMIC_INFO_FILE)
                        ?.openOutputStream()
                        ?.use {
                            val comicInfoString = xml.encodeToString(ComicInfo.serializer(), comicInfo)
                            it.write(comicInfoString.toByteArray())
                            legacyJsonDetailsFile.delete()
                        }
                }

                // Copy ComicInfo.xml from chapter archive to top level if found
                noXmlFile == null -> {
                    val chapterArchives = mangaDirFiles.filter(Archive::isSupported)

                    val copiedFile = copyComicInfoFileFromChapters(chapterArchives, mangaDir)
                    if (copiedFile != null) {
                        setMangaDetailsFromComicInfoFile(copiedFile.openInputStream(), manga)
                    } else {
                        // Avoid re-scanning
                        mangaDir.createFile(".noxml")
                    }
                }
            }
        } catch (e: Throwable) {
            logcat(LogPriority.ERROR, e) { "Error setting manga details from local metadata for ${manga.title}" }
        }

        return@withIOContext manga
    }

    private fun <T> getComicInfoForChapter(chapter: UniFile, block: (InputStream) -> T): T? {
        return if (chapter.isDirectory) {
            chapter.findFile(COMIC_INFO_FILE)?.openInputStream()?.use(block)
        } else {
            chapter.archiveReader(context).use { reader ->
                reader.getInputStream(COMIC_INFO_FILE)?.use(block)
            }
        }
    }

    private fun copyComicInfoFileFromChapters(chapterArchives: List<UniFile>, folder: UniFile): UniFile? {
        for (chapter in chapterArchives) {
            val file = getComicInfoForChapter(chapter) f@{ stream ->
                return@f copyComicInfoFile(stream, folder)
            }
            if (file != null) return file
        }
        return null
    }

    private fun copyComicInfoFile(comicInfoFileStream: InputStream, folder: UniFile): UniFile? {
        return folder.createFile(COMIC_INFO_FILE)?.apply {
            openOutputStream().use { outputStream ->
                comicInfoFileStream.use { it.copyTo(outputStream) }
            }
        }
    }

    private fun parseComicInfo(stream: InputStream): ComicInfo {
        return AndroidXmlReader(stream, StandardCharsets.UTF_8.name()).use {
            xml.decodeFromReader<ComicInfo>(it)
        }
    }

    private fun setMangaDetailsFromComicInfoFile(stream: InputStream, manga: SManga) {
        manga.copyFromComicInfo(parseComicInfo(stream))
    }

    private fun setChapterDetailsFromComicInfoFile(stream: InputStream, chapter: SChapter) {
        val comicInfo = parseComicInfo(stream)

        comicInfo.title?.let { chapter.name = it.value }
        comicInfo.number?.value?.toFloatOrNull()?.let { chapter.chapter_number = it }
        comicInfo.translator?.let { chapter.scanlator = it.value }
    }

    // Chapters
    private suspend fun getChapterList(manga: SManga): List<SChapter> = withIOContext {
        // Одиночный архив (CBZ/CBR в корне хранилища): манга = единственная глава
        val singleArchive = fileSystem.getMangaDirectory(manga.url) == null
        if (singleArchive) {
            val file = fileSystem.findEntry(manga.url)
            if (file != null && Archive.isSupported(file)) {
                val chapter = SChapter.create().apply {
                    url = manga.url
                    name = file.nameWithoutExtension.orEmpty()
                    date_upload = file.lastModified()
                    chapter_number = 1f
                }
                if (manga.thumbnail_url.isNullOrBlank()) {
                    updateCover(chapter, manga)
                }
                return@withIOContext listOf(chapter)
            }
            return@withIOContext emptyList()
        }

        val chapters = fileSystem.getFilesInMangaDirectory(manga.url)
            // Only keep supported formats
            .filterNot { it.name.orEmpty().startsWith('.') }
            .filterNot { it.name.orEmpty().lowercase() in setOf("local", "downloads", "backup", "autobackup", "covers") }
            // Папка-глава засчитывается только если в ней есть изображения —
            // случайные служебные подпапки больше не выглядят «главами»
            .filter { entry ->
                when {
                    Archive.isSupported(entry) || entry.extension.equals("epub", true) -> true
                    entry.isDirectory -> entry.listFiles().orEmpty().any { page ->
                        ImageUtil.isImage(page.name) { page.openInputStream() }
                    }
                    else -> false
                }
            }
            .map { chapterFile ->
                SChapter.create().apply {
                    url = "${manga.url}/${chapterFile.name}"
                    name = if (chapterFile.isDirectory) {
                        chapterFile.name
                    } else {
                        chapterFile.nameWithoutExtension
                    }.orEmpty()
                    date_upload = chapterFile.lastModified()
                    chapter_number = ChapterRecognition
                        .parseChapterNumber(manga.title, this.name, this.chapter_number.toDouble())
                        .toFloat()

                    val format = Format.valueOf(chapterFile)
                    if (format is Format.Epub) {
                        format.file.epubReader(context).use { epub ->
                            epub.fillMetadata(manga, this)
                        }
                    } else {
                        getComicInfoForChapter(chapterFile) { stream ->
                            setChapterDetailsFromComicInfoFile(stream, this)
                        }
                    }
                }
            }
            .sortedWith { c1, c2 ->
                c2.name.compareToCaseInsensitiveNaturalOrder(c1.name)
            }

        // Copy the cover from the first chapter found if not available
        if (manga.thumbnail_url.isNullOrBlank()) {
            chapters.lastOrNull()?.let { chapter ->
                updateCover(chapter, manga)
            }
        }

        chapters
    }

    // Filters
    override fun getFilterList() = FilterList(
        OrderBy.Popular(context),
        GenreFilter(runCatching { allKnownGenres() }.getOrDefault(emptyList())),
    )

    // Unused stuff
    override suspend fun getPageList(chapter: SChapter): List<Page> = throw UnsupportedOperationException("Unused")

    fun getFormat(chapter: SChapter): Format {
        try {
            val parts = chapter.url.split('/', limit = 2)
            val entry = if (parts.size == 2) {
                fileSystem.findEntry(parts[0])?.findFile(parts[1])
            } else {
                // Одиночный архив: манга = глава, url без '/'
                fileSystem.findEntry(parts[0])
            }
            return entry
                ?.let(Format.Companion::valueOf)
                ?: throw Exception(context.stringResource(MR.strings.chapter_not_found))
        } catch (e: Format.UnknownFormatException) {
            throw Exception(context.stringResource(MR.strings.local_invalid_format))
        } catch (e: Exception) {
            throw e
        }
    }

    /**
     * Генерирует обложку сразу при сканировании каталога: одиночный архив —
     * первая картинка внутри; папка-манга — первая картинка первой главы.
     * Дорогая часть выполняется один раз, дальше отдаётся из кэша .covers/cover.jpg.
     */
    private val coverQueue = java.util.concurrent.ConcurrentLinkedQueue<Pair<UniFile, SManga>>()
    private val coverQueued = java.util.Collections.newSetFromMap(
        java.util.concurrent.ConcurrentHashMap<String, Boolean>(),
    )
    private val coverWorkerRunning = java.util.concurrent.atomic.AtomicBoolean(false)
    private val coverScope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO,
    )

    /** Ставит генерацию обложки в фоновую очередь (один воркер, по одной). */
    private fun scheduleCoverGeneration(entry: UniFile, manga: SManga) {
        val key = entry.name.orEmpty()
        if (key.isBlank() || !coverQueued.add(key)) return
        coverQueue.add(entry to manga.apply { url = entry.name.orEmpty() })
        if (coverWorkerRunning.compareAndSet(false, true)) {
            coverScope.launch {
                try {
                    while (true) {
                        val (dir, m) = coverQueue.poll() ?: break
                        runCatching { tryGenerateCover(dir, m) }
                    }
                } finally {
                    coverWorkerRunning.set(false)
                }
            }
        }
    }

    private fun tryGenerateCover(entry: UniFile, manga: SManga): UniFile? {
        return runCatching {
            val chapterFile = if (entry.isDirectory) {
                entry.listFiles().orEmpty()
                    .filterNot { it.name.orEmpty().startsWith('.') }
                    .filter { it.isDirectory || Archive.isSupported(it) }
                    .minByOrNull { it.name.orEmpty().lowercase() }
            } else {
                entry.takeIf { Archive.isSupported(it) }
            } ?: return null

            val chapter = SChapter.create().apply {
                url = if (entry.isDirectory) "${entry.name}/${chapterFile.name}" else entry.name.orEmpty()
                name = chapterFile.nameWithoutExtension.orEmpty()
            }
            updateCover(chapter, manga)
        }.getOrNull()
    }

    private fun updateCover(chapter: SChapter, manga: SManga): UniFile? {
        return try {
            when (val format = getFormat(chapter)) {
                is Format.Directory -> {
                    val entry = format.file.listFiles()
                        ?.sortedWith { f1, f2 ->
                            f1.name.orEmpty().compareToCaseInsensitiveNaturalOrder(
                                f2.name.orEmpty(),
                            )
                        }
                        ?.find {
                            !it.isDirectory && ImageUtil.isImage(it.name) { it.openInputStream() }
                        }

                    entry?.let { coverManager.update(manga, it.openInputStream()) }
                }
                is Format.Archive -> {
                    format.file.archiveReader(context).use { reader ->
                        val entry = reader.useEntries { entries ->
                            entries
                                .sortedWith { f1, f2 -> f1.name.compareToCaseInsensitiveNaturalOrder(f2.name) }
                                .find { it.isFile && ImageUtil.isImage(it.name) { reader.getInputStream(it.name)!! } }
                        }

                        entry?.let { coverManager.update(manga, reader.getInputStream(it.name)!!) }
                    }
                }
                is Format.Epub -> {
                    format.file.epubReader(context).use { epub ->
                        val entry = epub.getImagesFromPages().firstOrNull()

                        entry?.let { coverManager.update(manga, epub.getInputStream(it)!!) }
                    }
                }
            }
        } catch (e: Throwable) {
            logcat(LogPriority.ERROR, e) { "Error updating cover for ${manga.title}" }
            null
        }
    }

    companion object {
        const val ID = 0L
        const val HELP_URL = "https://yomihon.github.io/docs/guides/local-source/"

        private val LATEST_THRESHOLD = 7.days.inWholeMilliseconds
    }
}

fun Manga.isLocal(): Boolean = source == LocalSource.ID

fun Source.isLocal(): Boolean = id == LocalSource.ID

fun DomainSource.isLocal(): Boolean = id == LocalSource.ID
