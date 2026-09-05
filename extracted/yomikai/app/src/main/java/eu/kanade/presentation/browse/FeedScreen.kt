package eu.kanade.presentation.browse

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.screen.Screen
import cafe.adriel.voyager.navigator.LocalNavigator
import cafe.adriel.voyager.navigator.currentOrThrow
import eu.kanade.presentation.components.AppBar
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.ui.browse.source.browse.BrowseSourceScreen
import kotlinx.coroutines.withTimeout
import tachiyomi.domain.source.service.SourceManager
import tachiyomi.presentation.core.components.material.Scaffold
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Лента обновлений источников (как в TachiyomiSY): для каждого включённого
 * каталожного источника подтягивается первая страница «Latest» и показывается
 * списком секций. Нажатие на мангу открывает поиск по её названию в этом
 * источнике, нажатие на заголовок — каталог источника.
 */
class FeedScreen : Screen {

    @Composable
    override fun Content() {
        val navigator = LocalNavigator.currentOrThrow
        FeedScreenContent(
            onNavigateUp = { navigator.pop() },
            onOpenSource = { sourceId, query -> navigator.push(BrowseSourceScreen(sourceId, query)) },
        )
    }
}

private data class FeedEntry(
    val sourceId: Long,
    val sourceName: String,
    val mangas: List<SManga>,
)

@Composable
private fun FeedScreenContent(
    onNavigateUp: () -> Unit,
    onOpenSource: (Long, String) -> Unit,
) {
    var loading by remember { mutableStateOf(true) }
    var entries by remember { mutableStateOf<List<FeedEntry>>(emptyList()) }
    var failed by remember { mutableStateOf(0) }
    val sourceManager = remember { Injekt.get<SourceManager>() }

    LaunchedEffect(Unit) {
        val sources = sourceManager.getOnlineSources()
            .filterIsInstance<CatalogueSource>()
            .filter { it.supportsLatest }
            .take(12)
        val result = mutableListOf<FeedEntry>()
        var failures = 0
        for (source in sources) {
            val page = runCatching {
                withTimeout(20_000L) { source.getLatestUpdates(1) }
            }.getOrNull()
            if (page != null && page.mangas.isNotEmpty()) {
                result += FeedEntry(source.id, source.name, page.mangas.take(20))
            } else {
                failures++
            }
        }
        entries = result
        failed = failures
        loading = false
    }

    Scaffold(
        topBar = {
            AppBar(
                title = "Лента обновлений",
                navigateUp = onNavigateUp,
            )
        },
    ) { contentPadding ->
        when {
            loading -> {
                LinearProgressIndicator(
                    modifier = Modifier
                        .padding(contentPadding)
                        .fillMaxWidth(),
                )
            }
            entries.isEmpty() -> {
                Text(
                    text = if (failed > 0) {
                        "Не удалось получить обновления ни из одного источника. Проверьте сеть и расширения."
                    } else {
                        "Нет источников с лентой обновлений. Установите расширения в разделе «Источник»."
                    },
                    modifier = Modifier
                        .padding(contentPadding)
                        .padding(24.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            else -> {
                LazyColumn(contentPadding = contentPadding) {
                    entries.forEach { entry ->
                        item(key = "header_${entry.sourceId}") {
                            Text(
                                text = entry.sourceName,
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenSource(entry.sourceId, "") }
                                    .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp),
                            )
                        }
                        items(items = entry.mangas) { manga ->
                            Text(
                                text = manga.title,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onOpenSource(entry.sourceId, manga.title) }
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                            )
                            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                        }
                    }
                    item {
                        Text(
                            text = "Обновлено из ${entries.size} ист." + if (failed > 0) " (ошибок: $failed)" else "",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(PaddingValues(16.dp)),
                        )
                    }
                }
            }
        }
    }
}
