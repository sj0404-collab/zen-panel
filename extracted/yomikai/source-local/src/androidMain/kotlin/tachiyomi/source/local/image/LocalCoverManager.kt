package tachiyomi.source.local.image

import android.content.Context
import com.hippo.unifile.UniFile
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.storage.DiskUtil
import tachiyomi.core.common.storage.nameWithoutExtension
import tachiyomi.core.common.util.system.ImageUtil
import tachiyomi.source.local.io.LocalSourceFileSystem
import java.io.InputStream

private const val DEFAULT_COVER_NAME = "cover.jpg"

actual class LocalCoverManager(
    private val context: Context,
    private val fileSystem: LocalSourceFileSystem,
) {

    actual fun find(mangaUrl: String): UniFile? {
        val inDir = fileSystem.getFilesInMangaDirectory(mangaUrl)
            // Get all file whose names start with "cover"
            .filter { it.isFile && it.nameWithoutExtension.equals("cover", ignoreCase = true) }
            // Get the first actual image
            .firstOrNull { ImageUtil.isImage(it.name) { it.openInputStream() } }
        if (inDir != null) return inDir

        // Одиночный архив: обложка хранится в скрытой папке .covers
        return coversDirectory()
            ?.findFile("$mangaUrl.jpg")
            ?.takeIf { it.isFile }
    }

    actual fun update(
        manga: SManga,
        inputStream: InputStream,
    ): UniFile? {
        val directory = fileSystem.getMangaDirectory(manga.url)
        val targetFile = if (directory != null) {
            find(manga.url) ?: directory.createFile(DEFAULT_COVER_NAME)!!
        } else {
            // Манга = одиночный CBZ/CBR: первую картинку архива кладём в .covers
            val coversDir = coversDirectory()
            if (coversDir == null) {
                inputStream.close()
                return null
            }
            coversDir.findFile("${manga.url}.jpg") ?: coversDir.createFile("${manga.url}.jpg")!!
        }

        inputStream.use { input ->
            targetFile.openOutputStream().use { output ->
                input.copyTo(output)
            }
        }

        (directory ?: coversDirectory())?.let { DiskUtil.createNoMediaFile(it, context) }

        manga.thumbnail_url = targetFile.uri.toString()
        return targetFile
    }

    private fun coversDirectory(): UniFile? {
        return fileSystem.getBaseDirectory()?.createDirectory(".covers")
    }
}
