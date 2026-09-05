package eu.kanade.tachiyomi.ui.locallibrary

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.navigator.tab.TabOptions
import eu.kanade.presentation.util.Tab
import eu.kanade.tachiyomi.ui.browse.source.browse.BrowseSourceScreen
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.onStart
import tachiyomi.core.common.storage.extension
import tachiyomi.core.common.util.lang.withIOContext
import tachiyomi.domain.library.model.LibraryIndex
import tachiyomi.domain.source.interactor.GetRemoteManga
import tachiyomi.domain.storage.service.StorageManager
import tachiyomi.domain.storage.service.StoragePreferences
import tachiyomi.source.local.LocalSource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Сторонняя (локальная) библиотека — отдельная от основного хранилища.
 *
 * Неограниченное число папок из любых мест (включая Android/data через SAF).
 * Каждая папка — категория: чипы под шапкой переключают «Все / конкретная
 * папка». Папка = манга, одиночный CBZ/CBR = манга с одной главой,
 * обложка из первого изображения. Статус-бар не перекрывается.
 */
data object LocalLibraryTab : Tab {

    private data class ScanStats(val mangaDirs: Int, val archives: Int)

    /**
     * Кэш статистики между заходами на вкладку. Раньше scanStorage()
     * перечитывал ВСЕ папки при каждом входе (и на каждый сигнал
     * storageManager.changes) — на большой библиотеке это фризило UI.
     * Теперь вход на вкладку мгновенный: показывается кэш, пересчёт
     * идёт в фоне только если изменился набор корневых папок.
     */
    @Volatile
    private var cachedStats: ScanStats? = null

    @Volatile
    private var cachedRootsKey: String = ""

    override val options: TabOptions
        @Composable
        get() {
            return TabOptions(
                index = 6u,
                title = "Локальная",
                icon = rememberVectorPainter(Icons.Outlined.Folder),
            )
        }

    override suspend fun onReselect(navigator: Navigator) {
    }

    @Composable
    override fun Content() {
        val context = LocalContext.current
        val storageManager = remember { Injekt.get<StorageManager>() }
        val storagePreferences = remember { Injekt.get<StoragePreferences>() }

        // Холодный вход больше НЕ блокирует интерфейс: сразу показываем вкладку
        // (без счётчиков), скан идёт в фоне, цифры появляются по готовности.
        var scanning by remember { mutableStateOf(false) }
        var stats by remember { mutableStateOf(cachedStats) }
        var roots by remember { mutableStateOf(storagePreferences.externalLibraryRoots.get().toList()) }
        var activeRoot by remember { mutableStateOf(storagePreferences.externalLibraryActiveRoot.get()) }
        var manageMode by remember { mutableStateOf(false) }
        // Сортировка списка: false — по алфавиту (OrderBy.Popular в LocalSource
        // сортирует по названию A→Я), true — сначала новые (OrderBy.Latest).
        var sortByNewest by remember { mutableStateOf(false) }
        // Алфавитный указатель: ключ из LibraryIndex.LETTERS или null («все»).
        // Ключ превращается в служебный запрос «#а», который LocalSource
        // разбирает как «название начинается на…».
        var letter by remember { mutableStateOf<String?>(null) }

        val addFolderLauncher = rememberLauncherForActivityResult(
            contract = ActivityResultContracts.OpenDocumentTree(),
        ) { uri ->
            if (uri != null) {
                val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                runCatching { context.contentResolver.takePersistableUriPermission(uri, flags) }
                storagePreferences.externalLibraryRoots.set(
                    storagePreferences.externalLibraryRoots.get() + uri.toString(),
                )
                roots = storagePreferences.externalLibraryRoots.get().toList()
                context.toast("Папка добавлена")
            }
        }

        LaunchedEffect(Unit) {
            storageManager.changes
                .onStart { emit(Unit) }
                .collectLatest {
                    roots = storagePreferences.externalLibraryRoots.get().toList()
                    activeRoot = storagePreferences.externalLibraryActiveRoot.get()
                    // Пересканируем ТОЛЬКО если изменился набор папок —
                    // обычный вход на вкладку берёт кэш и не трогает диск
                    val rootsKey = roots.sorted().joinToString("|")
                    if (cachedStats == null || rootsKey != cachedRootsKey) {
                        // Скан в фоне (withIOContext), UI живёт: показываем лёгкий
                        // индикатор, но список и кнопки остаются интерактивными.
                        scanning = true
                        val fresh = withIOContext { scanStorage(storageManager) }
                        cachedStats = fresh
                        cachedRootsKey = rootsKey
                        stats = fresh
                        scanning = false
                    } else {
                        stats = cachedStats
                        scanning = false
                    }
                }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding(),
        ) {
            Surface(
                // Фон шапки обязан совпадать с темой: surfaceVariant давал
                // серое пятно на тёмных окрасках (жалоба пользователя).
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(start = 16.dp, end = 4.dp),
                    ) {
                        if (scanning) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                            )
                            Text(
                                text = "  Сканирование папок…",
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.weight(1f),
                            )
                        } else {
                            val s = stats
                            Text(
                                text = when {
                                    roots.isEmpty() ->
                                        "📂 Добавьте папки с мангой (можно несколько, в т.ч. Android/data)"
                                    s == null || (s.mangaDirs == 0 && s.archives == 0) ->
                                        "📂 В выбранных папках манга не найдена"
                                    else ->
                                        "📚 Папок-манг: ${s.mangaDirs} • Архивов: ${s.archives}"
                                },
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier
                                    .weight(1f)
                                    .clickable { manageMode = !manageMode },
                            )
                        }
                        IconButton(onClick = { addFolderLauncher.launch(null) }) {
                            Icon(
                                Icons.Outlined.Add,
                                contentDescription = "Добавить папку",
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                    if (roots.isNotEmpty()) {
                        // Категории: Все + чип на каждую папку-источник
                        LazyRow(
                            modifier = Modifier.padding(horizontal = 12.dp),
                        ) {
                            item(key = "__all__") {
                                FilterChip(
                                    selected = activeRoot.isBlank(),
                                    onClick = {
                                        storagePreferences.externalLibraryActiveRoot.set("")
                                        activeRoot = ""
                                    },
                                    label = { Text("Все") },
                                    modifier = Modifier.padding(end = 6.dp),
                                )
                            }
                            items(roots, key = { it }) { uriString ->
                                FilterChip(
                                    selected = activeRoot == uriString,
                                    onClick = {
                                        val next = if (activeRoot == uriString) "" else uriString
                                        storagePreferences.externalLibraryActiveRoot.set(next)
                                        activeRoot = next
                                    },
                                    label = {
                                        Text(
                                            prettyUri(uriString),
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    },
                                    trailingIcon = if (manageMode) {
                                        {
                                            Icon(
                                                Icons.Outlined.Close,
                                                contentDescription = "Убрать",
                                                modifier = Modifier
                                                    .size(16.dp)
                                                    .clickable {
                                                        storagePreferences.externalLibraryRoots.set(
                                                            storagePreferences.externalLibraryRoots.get() - uriString,
                                                        )
                                                        if (activeRoot == uriString) {
                                                            storagePreferences.externalLibraryActiveRoot.set("")
                                                            activeRoot = ""
                                                        }
                                                        roots = storagePreferences.externalLibraryRoots.get().toList()
                                                        context.toast("Папка убрана")
                                                    },
                                            )
                                        }
                                    } else {
                                        null
                                    },
                                    modifier = Modifier.padding(end = 6.dp),
                                )
                            }
                        }
                    }
                    // Алфавитный указатель: А–Я (с «ё»), A–Z, цифры и «прочие».
                    // Повторный тап по букве сбрасывает указатель.
                    LazyRow(
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 4.dp),
                    ) {
                        item(key = "__index_all__") {
                            FilterChip(
                                selected = letter == null,
                                onClick = { letter = null },
                                label = { Text("Все") },
                                modifier = Modifier.padding(end = 4.dp),
                            )
                        }
                        items(LibraryIndex.LETTERS, key = { "__index_$it" }) { letterKey ->
                            FilterChip(
                                selected = letter == letterKey,
                                onClick = { letter = if (letter == letterKey) null else letterKey },
                                label = { Text(indexLabel(letterKey)) },
                                modifier = Modifier.padding(end = 4.dp),
                            )
                        }
                    }
                    LazyRow(
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                    ) {
                        item(key = "__sort_az__") {
                            FilterChip(
                                selected = !sortByNewest,
                                onClick = { sortByNewest = false },
                                label = { Text("А–Я") },
                                modifier = Modifier.padding(end = 6.dp),
                            )
                        }
                        item(key = "__sort_new__") {
                            FilterChip(
                                selected = sortByNewest,
                                onClick = { sortByNewest = true },
                                label = { Text("Сначала новые") },
                                modifier = Modifier.padding(end = 6.dp),
                            )
                        }
                    }
                }
            }
            // folderKey и listingQuery входят в data-класс экрана: при смене
            // папки, сортировки или буквы указателя Voyager пересоздаёт
            // ScreenModel и список перезапрашивается у LocalSource.
            //
            // С указателем список всегда идёт в порядке «название А→Я»: поиск
            // использует фильтры источника по умолчанию (OrderBy.Popular =
            // «название, по возрастанию»), и для полосы букв это ровно то, что
            // ждёт пользователь.
            val listingQuery = LibraryIndex.queryFor(letter)
                ?: if (sortByNewest) {
                    GetRemoteManga.QUERY_LATEST
                } else {
                    GetRemoteManga.QUERY_POPULAR
                }
            val folderKey = listOf(
                if (sortByNewest) "latest" else "az",
                activeRoot,
                letter.orEmpty(),
            ).joinToString("|")
            // ВАЖНО: одного data-класса экрана мало. Composable Navigator()
            // держит стек в remember{} и НЕ реагирует на новую ссылку screen:
            // без compose key() тап по чипу папки менял preference, но список
            // оставался прежним (баг с устройства: «чипы не фильтруют»).
            // key() утилизирует старый стек вместе со ScreenModel'ом.
            key(listingQuery, folderKey) {
                Navigator(
                    screen = BrowseSourceScreen(
                        sourceId = LocalSource.ID,
                        listingQuery = listingQuery,
                        folderKey = folderKey,
                    ),
                )
            }
        }
    }

    /**
     * Подпись чипа указателя: буквы заглавные, служебные ключи — словами,
     * чтобы «*» не выглядел опечаткой.
     */
    private fun indexLabel(key: String): String = when (key) {
        LibraryIndex.DIGITS -> "0–9"
        LibraryIndex.OTHER -> "прочие"
        else -> key.uppercase()
    }

    private fun prettyUri(uriString: String): String {
        return runCatching {
            java.net.URLDecoder.decode(uriString.substringAfterLast("/"), "UTF-8")
                .substringAfterLast(':')
                .substringAfterLast('/')
                .ifBlank { uriString }
        }.getOrDefault(uriString)
    }

    private fun scanStorage(storageManager: StorageManager): ScanStats {
        val archiveExts = setOf("cbz", "zip", "cbr", "rar", "epub")

        val local = storageManager.getLocalSourceDirectory()?.listFiles().orEmpty()
            .filterNot { it.name.orEmpty().startsWith('.') }
        val external = storageManager.getExternalLibraryRoots()
            .flatMap { it.listFiles().orEmpty().toList() }
            .filterNot { it.name.orEmpty().startsWith('.') }

        val all = (local + external).distinctBy { it.name }
        val dirs = all.count { it.isDirectory }
        val archives = all.count { file ->
            !file.isDirectory && file.extension.orEmpty().lowercase() in archiveExts
        }
        return ScanStats(dirs, archives)
    }
}
