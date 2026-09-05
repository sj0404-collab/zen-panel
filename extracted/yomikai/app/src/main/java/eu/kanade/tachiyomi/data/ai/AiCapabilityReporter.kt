package eu.kanade.tachiyomi.data.ai

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import mihon.domain.ocr.service.OcrPreferences
import java.io.File
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Отчёт о доступности: что возможно / что невозможно и почему.
 *
 * Пользователь жаловался: агент тратит 50к токенов на размышления и не говорит,
 * что доступно, а что нет. Теперь перед каждым ходом формируется краткий
 * capability-блок, который вставляется в системный промпт и показывается в UI.
 */
object AiCapabilityReporter {

    data class Capability(
        val name: String,
        val available: Boolean,
        val reason: String,
    )

    fun collect(context: Context): List<Capability> {
        val prefs: OcrPreferences = Injekt.get()
        val hasNetwork = isNetworkAvailable(context)
        val hasGoogleKey = prefs.googleApiKey().get().isNotBlank()
        val hasOpenRouterKey = prefs.openrouterApiKey().get().isNotBlank()
        val hasElevenKey = prefs.elevenApiKey().get().isNotBlank()
        val hasGithubPat = prefs.githubPat().get().isNotBlank()
        val allowRunner = prefs.aiAllowRunner().get()
        val allowGithub = prefs.aiAllowGithub().get()
        val backend = prefs.aiBackend().get()

        return listOf(
            Capability("Интернет", hasNetwork, if (hasNetwork) "OK" else "Нет сети — онлайн OCR/TTS/AI не работают"),
            Capability("Google AI (Gemini) — пол говорящих, OCR онлайн", hasGoogleKey && hasNetwork, when {
                !hasNetwork -> "Нет сети"
                !hasGoogleKey -> "Нет ключа в Настройки → Распознавание → Google AI"
                else -> "OK"
            }),
            Capability("OpenRouter", hasOpenRouterKey && hasNetwork, if (hasNetwork && !hasOpenRouterKey) "Нет ключа" else if (!hasNetwork) "Нет сети" else "OK"),
            Capability("Zen free (без ключа)", hasNetwork, if (!hasNetwork) "Нет сети" else "OK (бесплатно)"),
            Capability("ElevenLabs нейроголос", hasElevenKey && hasNetwork, if (!hasElevenKey) "Нет ключа ElevenLabs" else if (!hasNetwork) "Нет сети" else "OK"),
            Capability("TTS-сервер (ПК/ранер)", prefs.remoteTtsUrl().get().isNotBlank(), if (prefs.remoteTtsUrl().get().isBlank()) "Не указан адрес в Настройки → Голос" else "OK"),
            Capability("GitHub-ранер LLM", hasGithubPat && allowRunner && hasNetwork, when {
                !hasNetwork -> "Нет сети"
                !hasGithubPat -> "Нет PAT в Настройки → AI"
                !allowRunner -> "Выключено в Настройки → AI → Разрешить ранер"
                else -> "OK"
            }),
            Capability("GitHub API", hasGithubPat && allowGithub && hasNetwork, when {
                !hasNetwork -> "Нет сети"
                !hasGithubPat -> "Нет PAT"
                !allowGithub -> "Выключено в Настройки → AI"
                else -> "OK"
            }),
            Capability("Локальная LLM (.task в /sdcard/Yomikai/models)", FileProbe.hasLocalLlm(context), if (!FileProbe.hasLocalLlm(context)) "Нет .task модели" else "OK"),
            Capability("Бэкенд чата: $backend", true, when (backend) {
                "online" -> if (hasNetwork) "OK" else "Нет сети"
                "local" -> if (FileProbe.hasLocalLlm(context)) "OK" else "Нет модели"
                "runner" -> if (hasGithubPat && allowRunner) "OK" else "См. выше"
                else -> "Неизвестный бэкенд"
            }),
        )
    }

    fun renderForPrompt(context: Context): String {
        val caps = collect(context)
        return buildString {
            append("Доступность на этом устройстве (что возможно, что нет и почему):\n")
            caps.forEach { c ->
                append(if (c.available) "✅ " else "❌ ")
                append(c.name).append(": ").append(if (c.available) "доступно" else "недоступно")
                if (c.reason != "OK") append(" — ").append(c.reason)
                append("\n")
            }
            append("\nПравила: если функция недоступна — объясни причину и как включить; не трать токены на повторные попытки недоступного; отвечай на русском; reasoning кратко, не дублируй на двух языках.")
        }
    }

    fun renderForUi(context: Context): String {
        val caps = collect(context)
        val bad = caps.filter { !it.available }
        return if (bad.isEmpty()) "✅ Все основные функции доступны"
        else bad.joinToString("\n") { "❌ ${it.name}: ${it.reason}" }
    }

    private fun isNetworkAvailable(context: Context): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        } catch (_: Exception) { false }
    }

    private object FileProbe {
        fun hasLocalLlm(context: Context): Boolean {
            val candidates = listOf(
                File(context.getExternalFilesDir(null), "../../Yomikai/models").canonicalFile,
                File(context.filesDir, "models"),
            )
            return candidates.any { dir ->
                dir.exists() && dir.listFiles()?.any { it.name.endsWith(".task") } == true
            }
        }
    }
}
