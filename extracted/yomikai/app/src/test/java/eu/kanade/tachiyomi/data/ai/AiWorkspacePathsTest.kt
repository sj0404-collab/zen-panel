package eu.kanade.tachiyomi.data.ai

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Чистые функции workspace: защита имени файла и уникальность имён
 * zip-записей. Оба метода работают без Android и без файловой системы,
 * поэтому проверяются на JVM напрямую.
 */
class AiWorkspacePathsTest {

    @Test
    fun `sanitize keeps ordinary names intact`() {
        AiWorkspacePaths.sanitize("notes.txt") shouldBe "notes.txt"
        AiWorkspacePaths.sanitize("глава 1.md") shouldBe "глава 1.md"
        AiWorkspacePaths.sanitize("sub/dir/file.json") shouldBe "sub/dir/file.json"
    }

    @Test
    fun `sanitize strips traversal and characters illegal on storage`() {
        AiWorkspacePaths.sanitize("../../etc/passwd").contains("..") shouldBe false
        AiWorkspacePaths.sanitize("..\\..\\windows\\system32").contains("..") shouldBe false
        AiWorkspacePaths.sanitize("a<b>c:d.txt") shouldBe "a_b_c_d.txt"
        AiWorkspacePaths.sanitize("  spaced  ") shouldBe "spaced"
        // Ни один результат не должен содержать символов, запрещённых в FAT/ext4-именах.
        listOf("a*b?.txt", "x|y", "\"quoted\"", "back\\slash")
            .map { AiWorkspacePaths.sanitize(it) }
            .forEach { name ->
                name.any { it in setOf('\\', ':', '*', '?', '"', '<', '>', '|') } shouldBe false
            }
    }

    @Test
    fun `unique entry names keep the first occurrence unchanged`() {
        val used = mutableSetOf<String>()
        AiWorkspacePaths.uniqueEntryName("images/a.jpg", used) shouldBe "images/a.jpg"
        used shouldBe setOf("images/a.jpg")
    }

    @Test
    fun `duplicate entry names get a numeric suffix before the extension`() {
        val used = mutableSetOf<String>()
        AiWorkspacePaths.uniqueEntryName("a.txt", used) shouldBe "a.txt"
        AiWorkspacePaths.uniqueEntryName("a.txt", used) shouldBe "a_1.txt"
        AiWorkspacePaths.uniqueEntryName("a.txt", used) shouldBe "a_2.txt"
        // ZipOutputStream бросает ZipException на повторе — значит повторов нет.
        used.size shouldBe 3
    }

    @Test
    fun `names without extension and blank names are still made unique`() {
        val used = mutableSetOf<String>()
        AiWorkspacePaths.uniqueEntryName("README", used) shouldBe "README"
        AiWorkspacePaths.uniqueEntryName("README", used) shouldBe "README_1"
        AiWorkspacePaths.uniqueEntryName("", used) shouldBe "file"
        AiWorkspacePaths.uniqueEntryName("", used) shouldBe "file_1"
    }
}
