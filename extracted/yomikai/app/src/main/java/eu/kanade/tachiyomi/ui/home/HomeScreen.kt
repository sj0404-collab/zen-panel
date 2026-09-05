package eu.kanade.tachiyomi.ui.home

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import tachiyomi.presentation.core.util.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.util.fastForEach
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import cafe.adriel.voyager.navigator.tab.LocalTabNavigator
import cafe.adriel.voyager.navigator.tab.TabNavigator
import eu.kanade.domain.source.service.SourcePreferences
import eu.kanade.presentation.util.Screen
import eu.kanade.presentation.util.isTabletUi
import eu.kanade.tachiyomi.data.ui.UiTabRegistry
import eu.kanade.tachiyomi.ui.browse.BrowseTab
import eu.kanade.tachiyomi.ui.download.DownloadQueueScreen
import eu.kanade.tachiyomi.ui.history.HistoryTab
import eu.kanade.tachiyomi.ui.library.LibraryTab
import eu.kanade.tachiyomi.ui.manga.MangaScreen
import eu.kanade.tachiyomi.ui.more.MoreTab
import eu.kanade.tachiyomi.ui.updates.UpdatesTab
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mihon.data.ui.UiTab
import mihon.data.ui.UiTabs
import soup.compose.material.motion.animation.materialFadeThroughIn
import soup.compose.material.motion.animation.materialFadeThroughOut
import tachiyomi.domain.library.service.LibraryPreferences
import tachiyomi.i18n.MR
import tachiyomi.presentation.core.components.material.NavigationBar
import tachiyomi.presentation.core.components.material.NavigationRail
import tachiyomi.presentation.core.components.material.Scaffold
import tachiyomi.presentation.core.i18n.pluralStringResource
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

object HomeScreen : Screen() {

    private val librarySearchEvent = Channel<String>()
    private val openTabEvent = Channel<Tab>()
    private val showBottomNavEvent = Channel<Boolean>()

    @Suppress("ConstPropertyName")
    private const val TabFadeDuration = 200

    @Suppress("ConstPropertyName")
    private const val TabNavigatorKey = "HomeTabs"

    /**
     * Вкладки вместе со стабильными id из реестра [UiTabs]. Id нельзя брать из
     * имени класса: в release-сборке R8 переименовывает классы, а id живут в
     * файлах пользователя.
     */
    private val TABS = listOf(
        UiTab.LIBRARY to LibraryTab,
        UiTab.LOCAL_LIBRARY to eu.kanade.tachiyomi.ui.locallibrary.LocalLibraryTab,
        UiTab.UPDATES to UpdatesTab,
        UiTab.HISTORY to HistoryTab,
        UiTab.BROWSE to BrowseTab,
        UiTab.BROWSER to eu.kanade.tachiyomi.ui.webbrowser.BrowserTab,
        UiTab.AI to eu.kanade.tachiyomi.ui.aichat.AiChatTab,
        // DictionaryTab скрыт из нижней навигации («в дальний ящик»):
        // словарь доступен из Ещё → Настройки → Словарь
        UiTab.MORE to MoreTab,
    )

    /**
     * Видимые вкладки.
     *
     * «AI» скрывается в её же настройках (агент тогда доступен из внешнего
     * браузера через встроенный сервер), остальные — через реестр [UiTabRegistry]
     * (AI-чат: `ui_tab_hide` / `ui_tab_show`, либо файл `workspace/ui/tabs.json`).
     * Библиотека и «Ещё» закреплены в [UiTabs.PROTECTED_IDS]: без них приложение
     * останется без контента или без входа в настройки, и вернуть вкладку будет
     * нечем.
     *
     * Список читается на `Dispatchers.IO` и перечитывается на каждый рост
     * [UiTabRegistry.version], поэтому скрытие вкладки из чата видно сразу, без
     * перезапуска.
     */
    @Composable
    private fun visibleTabs(): List<eu.kanade.presentation.util.Tab> {
        val prefs = remember { Injekt.get<mihon.domain.ocr.service.OcrPreferences>() }
        val aiVisible by prefs.aiTabVisible().collectAsState()
        val context = LocalContext.current
        val version by UiTabRegistry.version.collectAsState()
        val ctorVersion by eu.kanade.tachiyomi.data.ui.UiConstructorStore.version.collectAsState()
        var hidden by remember { mutableStateOf(emptySet<String>()) }
        var order by remember { mutableStateOf(emptyList<String>()) }
        LaunchedEffect(version, ctorVersion) {
            val (h, o) = withContext(Dispatchers.IO) {
                UiTabRegistry.hidden(context) to eu.kanade.tachiyomi.data.ui.UiConstructorStore.tabOrder(context)
            }
            hidden = h
            order = o
        }
        return TABS
            .filterNot { (tab, _) -> tab == UiTab.AI && !aiVisible }
            .filterNot { (tab, _) -> UiTabs.isHidden(tab.id, hidden) }
            .let { list ->
                if (order.isEmpty()) {
                    list
                } else {
                    list.sortedBy { (tab, _) ->
                        val i = order.indexOf(tab.id)
                        if (i < 0) Int.MAX_VALUE else i
                    }
                }
            }
            .map { (_, screen) -> screen }
    }

    @Composable
    override fun Content() {
        // PWA-оболочка Yomihon удалена: приложение всегда работает в нативном
        // интерфейсе, MangaLib PWA живёт как нативная вкладка с мостами.
        val navigator = LocalNavigator.currentOrThrow
        TabNavigator(
            tab = LibraryTab,
            key = TabNavigatorKey,
        ) { tabNavigator ->
            // Provide usable navigator to content screen
            CompositionLocalProvider(LocalNavigator provides navigator) {
                val tabsToShow = visibleTabs()
                Scaffold(
                    startBar = {
                        if (isTabletUi()) {
                            NavigationRail {
                                tabsToShow.fastForEach {
                                    NavigationRailItem(it)
                                }
                            }
                        }
                    },
                    bottomBar = {
                        if (!isTabletUi()) {
                            val bottomNavVisible by produceState(initialValue = true) {
                                showBottomNavEvent.receiveAsFlow().collectLatest { value = it }
                            }
                            AnimatedVisibility(
                                visible = bottomNavVisible,
                                enter = expandVertically(),
                                exit = shrinkVertically(),
                            ) {
                                NavigationBar {
                                    tabsToShow.fastForEach {
                                        NavigationBarItem(it)
                                    }
                                }
                            }
                        }
                    },
                    contentWindowInsets = WindowInsets(0),
                ) { contentPadding ->
                    Box(
                        modifier = Modifier
                            .padding(contentPadding)
                            .consumeWindowInsets(contentPadding),
                    ) {
                        AnimatedContent(
                            targetState = tabNavigator.current,
                            transitionSpec = {
                                materialFadeThroughIn(initialScale = 1f, durationMillis = TabFadeDuration) togetherWith
                                    materialFadeThroughOut(durationMillis = TabFadeDuration)
                            },
                            label = "tabContent",
                        ) {
                            tabNavigator.saveableState(key = "currentTab", it) {
                                it.Content()
                            }
                        }
                    }
                }
            }

            val goToLibraryTab = { tabNavigator.current = LibraryTab }

            BackHandler(enabled = tabNavigator.current != LibraryTab, onBack = goToLibraryTab)

            LaunchedEffect(Unit) {
                launch {
                    librarySearchEvent.receiveAsFlow().collectLatest {
                        goToLibraryTab()
                        LibraryTab.search(it)
                    }
                }
                launch {
                    openTabEvent.receiveAsFlow().collectLatest {
                        tabNavigator.current = when (it) {
                            is Tab.Library -> LibraryTab
                            Tab.Updates -> UpdatesTab
                            Tab.History -> HistoryTab
                            is Tab.Browse -> {
                                if (it.toExtensions) {
                                    BrowseTab.showExtension()
                                }
                                BrowseTab
                            }
                            Tab.Dictionary -> MoreTab // словарь скрыт из таб-бара
                            is Tab.More -> MoreTab
                            // Вкладку AI можно скрыть в настройках; открывать
                            // несуществующую вкладку нельзя — уходим в библиотеку.
                            Tab.AiChat ->
                                if (Injekt.get<mihon.domain.ocr.service.OcrPreferences>()
                                        .aiTabVisible()
                                        .get()
                                ) {
                                    eu.kanade.tachiyomi.ui.aichat.AiChatTab
                                } else {
                                    LibraryTab
                                }
                        }

                        if (it is Tab.Library && it.mangaIdToOpen != null) {
                            navigator.push(MangaScreen(it.mangaIdToOpen))
                        }
                        if (it is Tab.More && it.toDownloads) {
                            navigator.push(DownloadQueueScreen)
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun RowScope.NavigationBarItem(tab: eu.kanade.presentation.util.Tab) {
        val tabNavigator = LocalTabNavigator.current
        val navigator = LocalNavigator.currentOrThrow
        val scope = rememberCoroutineScope()
        val selected = tabNavigator.current::class == tab::class
        NavigationBarItem(
            selected = selected,
            onClick = {
                if (!selected) {
                    tabNavigator.current = tab
                } else {
                    scope.launch { tab.onReselect(navigator) }
                }
            },
            icon = { NavigationIconItem(tab) },
            label = {
                Text(
                    text = tab.options.title,
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            alwaysShowLabel = true,
        )
    }

    @Composable
    fun NavigationRailItem(tab: eu.kanade.presentation.util.Tab) {
        val tabNavigator = LocalTabNavigator.current
        val navigator = LocalNavigator.currentOrThrow
        val scope = rememberCoroutineScope()
        val selected = tabNavigator.current::class == tab::class
        NavigationRailItem(
            selected = selected,
            onClick = {
                if (!selected) {
                    tabNavigator.current = tab
                } else {
                    scope.launch { tab.onReselect(navigator) }
                }
            },
            icon = { NavigationIconItem(tab) },
            label = {
                Text(
                    text = tab.options.title,
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            alwaysShowLabel = true,
        )
    }

    @Composable
    private fun NavigationIconItem(tab: eu.kanade.presentation.util.Tab) {
        BadgedBox(
            badge = {
                when {
                    tab is UpdatesTab -> {
                        val count by produceState(initialValue = 0) {
                            val pref = Injekt.get<LibraryPreferences>()
                            combine(
                                pref.newShowUpdatesCount.changes(),
                                pref.newUpdatesCount.changes(),
                            ) { show, count -> if (show) count else 0 }
                                .collectLatest { value = it }
                        }
                        if (count > 0) {
                            Badge {
                                val desc = pluralStringResource(
                                    MR.plurals.notification_chapters_generic,
                                    count = count,
                                    count,
                                )
                                Text(
                                    text = count.toString(),
                                    modifier = Modifier.semantics { contentDescription = desc },
                                )
                            }
                        }
                    }
                    BrowseTab::class.isInstance(tab) -> {
                        val count by produceState(initialValue = 0) {
                            Injekt.get<SourcePreferences>().extensionUpdatesCount.changes()
                                .collectLatest { value = it }
                        }
                        if (count > 0) {
                            Badge {
                                val desc = pluralStringResource(
                                    MR.plurals.update_check_notification_ext_updates,
                                    count = count,
                                    count,
                                )
                                Text(
                                    text = count.toString(),
                                    modifier = Modifier.semantics { contentDescription = desc },
                                )
                            }
                        }
                    }
                }
            },
        ) {
            Icon(
                painter = tab.options.icon!!,
                contentDescription = tab.options.title,
            )
        }
    }

    suspend fun search(query: String) {
        librarySearchEvent.send(query)
    }

    suspend fun openTab(tab: Tab) {
        openTabEvent.send(tab)
    }

    /**
     * Когда включён PWA-режим, нативные экраны недоступны напрямую.
     * PWA-мост поднимает этот флаг, чтобы временно показать нативный UI
     * (библиотека/обзор/расширения/загрузки), а кнопка "Назад" возвращает в PWA.
     */
    val pwaTemporarilyHidden = kotlinx.coroutines.flow.MutableStateFlow(false)

    fun showNativeUi() {
        pwaTemporarilyHidden.value = true
    }

    fun returnToPwa() {
        pwaTemporarilyHidden.value = false
    }

    suspend fun showBottomNav(show: Boolean) {
        showBottomNavEvent.send(show)
    }

    sealed interface Tab {
        data class Library(val mangaIdToOpen: Long? = null) : Tab
        data object Updates : Tab
        data object History : Tab
        data class Browse(val toExtensions: Boolean = false) : Tab
        data object Dictionary : Tab

        /** Вкладка «AI»: агент, чат, workspace и плагины разработчика. */
        data object AiChat : Tab
        data class More(val toDownloads: Boolean) : Tab
    }
}
