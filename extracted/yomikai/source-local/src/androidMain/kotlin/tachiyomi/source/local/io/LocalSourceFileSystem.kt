package tachiyomi.source.local.io

import com.hippo.unifile.UniFile
import tachiyomi.domain.storage.service.StorageManager

actual class LocalSourceFileSystem(
    private val storageManager: StorageManager,
) {

    actual fun getBaseDirectory(): UniFile? {
        return storageManager.getLocalSourceDirectory()
    }

    /**
     * Сторонняя библиотека НЕ смешивается с хранилищем приложения:
     * сканируются подпапка local/ (манга самого приложения) и все внешние
     * папки-корни, добавленные пользователем (сколько угодно, из любых мест,
     * включая Android/data через SAF). Корень основного хранилища (папка
     * загрузок из сети) больше не сканируется — никаких дублей.
     */
    actual fun getFilesInBaseDirectory(): List<UniFile> {
        val local = getBaseDirectory()?.listFiles().orEmpty().toList()
        val external = storageManager.getExternalLibraryRoots()
            .flatMap { root -> root.listFiles().orEmpty().toList() }
        // Служебные папки приложения не должны показываться как «манга»
        return (local + external).filterNot { it.name.orEmpty().lowercase() in RESERVED_DIR_NAMES }
    }

    actual fun getMangaDirectory(name: String): UniFile? {
        return findEntry(name)
            ?.takeIf { it.isDirectory }
    }

    actual fun getFilesInMangaDirectory(name: String): List<UniFile> {
        return getMangaDirectory(name)?.listFiles().orEmpty().toList()
    }

    /** Ищет запись (папку или файл) в local/, затем во всех внешних корнях. */
    fun findEntry(name: String): UniFile? {
        getBaseDirectory()?.findFile(name)?.let { return it }
        for (root in storageManager.getExternalLibraryRoots()) {
            root.findFile(name)?.let { return it }
        }
        return null
    }
}

private val RESERVED_DIR_NAMES = hashSetOf(
    "local", "downloads", "backup", "autobackup", "automatic_backups", "covers", ".thumbnails",
)
