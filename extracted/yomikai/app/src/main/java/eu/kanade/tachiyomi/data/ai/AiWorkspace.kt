package eu.kanade.tachiyomi.data.ai

import android.content.Context
import android.os.Environment
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Workspace встроенного AI-ассистента: реальная папка на диске, куда
 * ассистент складывает результаты (файлы, картинки, архивы), а пользователь
 * может забрать их в любой момент — файловым менеджером или из UI чата.
 *
 * Расположение: /sdcard/Yomikai/AI (создаётся автоматически). Если внешнее
 * хранилище недоступно — приватная папка приложения (files/ai_workspace).
 *
 * ## Контракт надёжности
 *
 * Ни один публичный метод не бросает исключение наружу. Workspace живёт на
 * общем хранилище, которое пользователь может размонтировать, а права —
 * отозвать в любой момент; кроме того, часть методов вызывается прямо из
 * Compose. Поэтому каждая операция обёрнута в `runCatching`, а неудача
 * возвращается как `null` / `false` / пустой список и логируется. Падение
 * одной операции с файлом не должно уносить приложение.
 */
object AiWorkspace {

    private const val DIR_NAME = "AI"

    /** Ограничение на число записей в списке, чтобы большой workspace не съел память. */
    private const val MAX_LIST_ENTRIES = 5_000

    /**
     * Кэш разрешённого корня. `root()` дёргается из `relPath()` на каждую
     * строку списка файлов, а раньше каждый вызов заново делал `mkdirs()` —
     * то есть дисковый ввод на главном потоке. Корень процесса не меняется,
     * поэтому запоминаем его один раз.
     */
    @Volatile
    private var cachedRoot: File? = null

    fun root(context: Context): File {
        cachedRoot?.let { return it }
        val resolved = runCatching {
            val external = File(Environment.getExternalStorageDirectory(), "Yomikai/$DIR_NAME")
            val dir = if (external.parentFile?.exists() == true || external.mkdirs() || external.exists()) {
                external
            } else {
                File(context.filesDir, "ai_workspace")
            }
            dir.mkdirs()
            File(dir, "images").mkdirs()
            File(dir, "inbox").mkdirs()
            dir.takeIf { it.isDirectory } ?: File(context.filesDir, "ai_workspace").apply { mkdirs() }
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace root failed, falling back to internal storage" }
            runCatching { File(context.filesDir, "ai_workspace").apply { mkdirs() } }
                .getOrElse { File(context.cacheDir, "ai_workspace").apply { mkdirs() } }
        }
        cachedRoot = resolved
        return resolved
    }

    /**
     * Все файлы workspace (рекурсивно), отсортированы: папки → новые файлы.
     * Пустой список — и когда workspace пуст, и когда хранилище недоступно.
     */
    fun listAll(context: Context): List<File> = runCatching {
        val r = root(context)
        r.walkTopDown()
            .onEnter { dir -> runCatching { dir.canRead() }.getOrDefault(false) }
            .filter { it != r }
            .take(MAX_LIST_ENTRIES)
            .sortedWith(compareBy({ !it.isDirectory }, { -runCatching { it.lastModified() }.getOrDefault(0L) }))
            .toList()
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "AiWorkspace listAll failed" }
        emptyList()
    }

    fun relPath(context: Context, f: File): String = runCatching {
        f.absolutePath.removePrefix(root(context).absolutePath).trimStart('/')
    }.getOrDefault(f.name)

    /** Безопасное разрешение относительного пути (без выхода из workspace). */
    fun resolve(context: Context, rel: String): File? = runCatching {
        val r = root(context)
        val f = File(r, rel.trim().trimStart('/'))
        if (f.canonicalPath.startsWith(r.canonicalPath)) f else null
    }.getOrElse { e ->
        logcat(LogPriority.WARN, e) { "AiWorkspace resolve failed for '$rel'" }
        null
    }

    /** Сохранить текстовый файл; подпапки в имени создаются автоматически. */
    fun writeText(context: Context, name: String, content: String): File? {
        val f = resolve(context, sanitize(name)) ?: return null
        return runCatching {
            f.parentFile?.mkdirs()
            f.writeText(content)
            f
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace writeText failed for '$name'" }
            null
        }
    }

    fun newImageFile(context: Context, hint: String): File {
        val safe = sanitize(hint).take(40).ifBlank { "image" }
        return File(File(root(context), "images"), "${safe}_${System.currentTimeMillis() % 100000}.jpg")
    }

    /** Копия вложения пользователя в workspace/inbox; `null`, если запись не удалась. */
    fun importAttachment(context: Context, displayName: String, bytes: ByteArray): File? {
        val f = File(
            File(root(context), "inbox"),
            sanitize(displayName).ifBlank { "file_${System.currentTimeMillis()}" },
        )
        return runCatching {
            f.parentFile?.mkdirs()
            f.writeBytes(bytes)
            f
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace importAttachment failed for '$displayName'" }
            null
        }
    }

    /**
     * Упаковать весь workspace (кроме прежних архивов) в zip.
     * `null`, если архив собрать не удалось (нет места, хранилище размонтировано).
     */
    fun zipAll(context: Context): File? {
        val r = root(context)
        val out = File(r, "workspace_${System.currentTimeMillis() / 1000}.zip")
        val ok = runCatching {
            // Имена записей обязаны быть уникальны, иначе ZipOutputStream бросает
            // ZipException("duplicate entry") — а файлы в разных папках могут
            // совпадать по имени, если relPath() упал и вернул только имя.
            val used = HashSet<String>()
            ZipOutputStream(FileOutputStream(out)).use { zos ->
                r.walkTopDown()
                    .onEnter { dir -> runCatching { dir.canRead() }.getOrDefault(false) }
                    .filter { it.isFile && it != out && !it.name.endsWith(".zip") }
                    .forEach { f ->
                        val name = AiWorkspacePaths.uniqueEntryName(
                            relPath(context, f).ifBlank { f.name },
                            used,
                        )
                        runCatching {
                            FileInputStream(f).use { fis ->
                                zos.putNextEntry(ZipEntry(name))
                                fis.copyTo(zos)
                                zos.closeEntry()
                            }
                        }.onFailure { e ->
                            logcat(LogPriority.WARN, e) { "AiWorkspace zip skipped '$name'" }
                        }
                    }
            }
            true
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace zipAll failed" }
            false
        }
        if (!ok) {
            runCatching { out.delete() }
            return null
        }
        return out
    }

    /**
     * Бэкап файла перед правкой (чтобы агент «не сломал» файл): копия в
     * backups/<имя>.<timestamp>. Держим до 5 последних бэкапов на файл.
     */
    fun backup(context: Context, f: File): File? {
        if (!runCatching { f.isFile }.getOrDefault(false)) return null
        val dir = File(root(context), "backups").apply { mkdirs() }
        val stamp = System.currentTimeMillis() / 1000
        val dst = File(dir, "${f.name}.$stamp")
        return runCatching {
            f.copyTo(dst, overwrite = true)
            // Ротация: не больше 5 бэкапов на файл
            dir.listFiles { c -> c.name.startsWith(f.name + ".") }
                ?.sortedByDescending { it.name }
                ?.drop(5)
                ?.forEach { runCatching { it.delete() } }
            dst
        }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace backup failed for '${f.name}'" }
            null
        }
    }

    fun delete(context: Context, rel: String): Boolean {
        val f = resolve(context, rel) ?: return false
        return runCatching { f.deleteRecursively() }.getOrElse { e ->
            logcat(LogPriority.WARN, e) { "AiWorkspace delete failed for '$rel'" }
            false
        }
    }

    /** Делегирует чистой реализации, которую покрывают unit-тесты. */
    private fun sanitize(name: String): String = AiWorkspacePaths.sanitize(name)
}
