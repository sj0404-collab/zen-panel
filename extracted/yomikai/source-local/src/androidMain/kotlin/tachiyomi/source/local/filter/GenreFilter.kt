package tachiyomi.source.local.filter

import eu.kanade.tachiyomi.source.model.Filter

/**
 * Жанровый фильтр локальной библиотеки — как в онлайн-каталогах.
 * Список жанров собирается из ComicInfo.xml всех манг и кэшируется.
 */
class GenreFilter(genres: List<String>) : Filter.Select<String>(
    "Жанр",
    (listOf("Все жанры") + genres).toTypedArray(),
) {
    val selectedGenre: String?
        get() = if (state == 0) null else values.getOrNull(state)
}
