package eu.kanade.tachiyomi.data.tts

import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import logcat.LogPriority
import tachiyomi.core.common.util.system.logcat
import java.util.Locale

enum class VoiceKind { FEMALE, MALE, TEEN, OTHER }

/**
 * Классификация системных голосов по полу и подбор голоса для реплики.
 *
 * Важно: у Google Speech Services (самый распространённый движок на Android)
 * голоса называются НЕ по именам, а кодами вида `ru-ru-x-dfc-local`,
 * `ru-ru-x-ruf-network`. Прежняя версия искала в имени «svetlana»/«dmitry»
 * (это стиль Яндекс/RHVoice), поэтому все Google-голоса попадали в OTHER,
 * и pick(FEMALE)/pick(MALE) возвращали один и тот же первый голос — из-за
 * этого «работал только один голос».
 *
 * Теперь классификация трёхступенчатая:
 * 1. [Voice.getFeatures] / имя содержит явный признак пола;
 * 2. таблица известных кодов Google (`dfc`, `ruf`, … — женские; `rud`, `rue`,
 *    … — мужские) — коды берутся из середины имени `xx-xx-x-CODE-local`;
 * 3. детерминированный запасной вариант: голоса сортируются и делятся между
 *    полами по индексу, чтобы разные роли всё равно звучали по-разному.
 */
object VoiceHelper {
    private val femaleHints = listOf(
        "female", "woman", "svetlana", "milena", "oksana", "irina", "jane", "ksenia",
        "alena", "yelena", "elena", "anna", "arina", "maria", "natalia", "natalya",
        "tatiana", "tatyana", "victoria", "lyubov", "marianna", "жен", "женск", "девуш",
    )
    private val maleHints = listOf(
        "male", "man", "dmitry", "dmitri", "ermil", "filipp", "zahar", "pavel",
        "alexander", "aleksandr", "artemiy", "evgeniy", "mikhail", "vitaliy", "yuriy",
        "timofey", "seva", "anatol", "volodymyr", "maxim", "andrey", "ivan", "sergey", "муж",
    )
    private val teenHints = listOf("child", "kid", "teen", "young", "дет", "подрост", "umka")
    private val blacklist = listOf("locale", "default", "test")

    /**
     * Some OEM Android builds return an empty getVoices() set for RHVoice,
     * even though setVoice(name) and synthesis work. RHVoice validates a
     * manually constructed Voice by its name, so this catalog is used only as
     * a last-resort probe and only installed/enabled names are retained.
     */
    private val rhVoiceCatalog = mapOf(
        "ru" to listOf(
            "Aleksandr", "Aleksandr-hq", "Anna", "Arina", "Artemiy", "Elena",
            "Evgeniy-Rus", "Irina", "Mikhail", "Pavel", "Seva", "Tatiana",
            "Timofey", "Umka", "Victoria", "Vitaliy", "Yuriy",
        ),
        "en" to listOf("Alan", "BDL", "CLB", "Evgeniy-Eng", "Lyubov", "SLT"),
        "uk" to listOf("Anatol", "Marianna", "Natalia", "Volodymyr"),
    )

    private val languageAliases = mapOf(
        "ru" to setOf("ru", "rus"),
        "en" to setOf("en", "eng"),
        "ja" to setOf("ja", "jpn"),
        "ko" to setOf("ko", "kor"),
        "zh" to setOf("zh", "zho", "chi"),
        "uk" to setOf("uk", "ukr"),
    )

    /**
     * Коды голосов Google Speech Services. Имя выглядит как
     * `ru-ru-x-dfc-local`, значащая часть — предпоследний сегмент.
     */
    private val googleFemaleCodes = setOf(
        // ru
        "dfc", "ruf", "rug",
        // en
        "iob", "iog", "sfg", "tpc", "tpf", "jomn", "iol",
        // прочие распространённые
        "afb", "bfa", "cfa", "dfa", "dfb", "efa", "ffa", "gfa", "hfa", "sfb",
    )
    private val googleMaleCodes = setOf(
        // ru
        "rue", "rud", "dmc",
        // en
        "iom", "iog2", "tpd", "sfb2", "jomn2",
        // прочие распространённые
        "ama", "bma", "cma", "dma", "dmb", "ema", "fma", "gma", "hma", "smb",
    )

    fun russianVoices(tts: TextToSpeech?, enginePackage: String? = null): List<Voice> =
        voicesFor(tts, "ru", enginePackage)

    /** Ask a lazy TTS engine to load the requested language before getVoices(). */
    fun prepareForLanguage(tts: TextToSpeech?, language: String): Int {
        val engine = tts ?: return TextToSpeech.ERROR
        val locale = localeFor(language)
        runCatching { engine.isLanguageAvailable(locale) }
        return runCatching { engine.setLanguage(locale) }.getOrDefault(TextToSpeech.ERROR)
    }

    /**
     * Голоса для языка [language] (ISO-639-1). Handles ISO-2/ISO-3 locale
     * differences, lazy engines and an RHVoice-specific OEM fallback.
     */
    fun voicesFor(
        tts: TextToSpeech?,
        language: String,
        enginePackage: String? = null,
    ): List<Voice> {
        val engine = tts ?: return emptyList()
        val packageName = enginePackage?.takeIf { it.isNotBlank() }
            ?: runCatching { engine.defaultEngine }.getOrNull()
        val isRhVoice = packageName.orEmpty().contains("rhvoice", ignoreCase = true)
        val all = try {
            engine.voices.orEmpty()
        } catch (e: Exception) {
            logcat(LogPriority.WARN, e) { "voices() failed" }
            emptySet()
        }
        val filtered = all.filter { voice ->
            languageMatches(voice.locale, language) &&
                blacklist.none { blocked -> voice.name.equals(blocked, true) }
        }.sortedBy { it.name }
        if (isRhVoice) {
            val direct = filtered.filterNot {
                it.name.equals("Russian", true) || it.name.equals("English", true)
            }
            if (direct.size > 1) return direct
            val probed = installedRhVoices(engine, language)
            val merged = (direct + probed)
                .distinctBy { it.name.lowercase(Locale.US) }
                .sortedBy { it.name }
            if (merged.isNotEmpty()) return merged
        }
        if (filtered.isNotEmpty()) return filtered

        // Some engines expose only the currently loaded/default Voice while
        // getVoices() is empty. Keep these as a generic one-voice fallback.
        return buildList {
            runCatching { engine.voice }.getOrNull()?.let(::add)
            runCatching { engine.defaultVoice }.getOrNull()?.let(::add)
        }.distinctBy { it.name }
            .filter { languageMatches(it.locale, language) }
            .sortedBy { it.name }
    }

    private fun localeFor(language: String): Locale = when (language.lowercase(Locale.US)) {
        "ru" -> Locale("ru", "RU")
        "en" -> Locale.US
        "ja" -> Locale.JAPAN
        "ko" -> Locale.KOREA
        "zh" -> Locale.SIMPLIFIED_CHINESE
        "uk" -> Locale("uk", "UA")
        else -> Locale(language)
    }

    private fun languageMatches(locale: Locale, language: String): Boolean {
        val requested = language.lowercase(Locale.US).substringBefore('-').substringBefore('_')
        val accepted = languageAliases[requested] ?: setOf(requested)
        val actual = buildSet {
            add(locale.language.lowercase(Locale.US))
            runCatching { locale.isO3Language.lowercase(Locale.US) }.getOrNull()?.let(::add)
        }
        return actual.any { it in accepted }
    }

    /**
     * RHVoice's service accepts a Voice by exact name and returns ERROR for a
     * missing/disabled pack. This lets us recover the installed subset on OEM
     * firmware where Android loses the service's onGetVoices() response.
     */
    /** Local RHVoice catalog used by the settings UI and loopback HTTP API. */
    fun localCatalog(language: String): List<Voice> {
        val lang = language.lowercase(Locale.US)
        val locale = localeFor(lang)
        return rhVoiceCatalog[lang].orEmpty().map { name ->
            Voice(
                name,
                locale,
                Voice.QUALITY_NORMAL,
                Voice.LATENCY_NORMAL,
                false,
                emptySet(),
            )
        }
    }

    private fun installedRhVoices(tts: TextToSpeech, language: String): List<Voice> {
        val candidates = localCatalog(language)
        if (candidates.isEmpty()) return emptyList()
        val original = runCatching { tts.voice }.getOrNull()
        val accepted = candidates.filter { candidate ->
            runCatching { tts.setVoice(candidate) == TextToSpeech.SUCCESS }.getOrDefault(false)
        }
        if (original != null) {
            runCatching { tts.setVoice(original) }
        } else {
            runCatching { tts.setLanguage(localeFor(language)) }
        }
        // Several OEM TextToSpeech clients reject manually constructed Voice
        // objects before RHVoice sees them. The same names still work when sent
        // as Engine.KEY_PARAM_VOICE_NAME with speak(), so keep the local list.
        return accepted.ifEmpty { candidates }
    }

    /** Значащий сегмент имени Google-голоса: `ru-ru-x-dfc-local` -> `dfc`. */
    private fun googleCode(name: String): String? {
        val parts = name.lowercase(Locale.US).split('-')
        val xIndex = parts.indexOf("x")
        return if (xIndex >= 0 && xIndex + 1 < parts.size) parts[xIndex + 1] else null
    }

    fun classify(v: Voice): VoiceKind {
        val n = (v.name + " " + v.locale.toLanguageTag()).lowercase(Locale.US)

        // 1) признак пола, объявленный самим движком
        val features = runCatching { v.features }.getOrNull().orEmpty()
        features.forEach { f ->
            val lf = f.lowercase(Locale.US)
            if (lf.contains("female")) return VoiceKind.FEMALE
            if (lf.contains("male")) return VoiceKind.MALE
        }

        // 2) явные подсказки в имени (Яндекс, RHVoice, Samsung)
        when {
            teenHints.any { n.contains(it) } -> return VoiceKind.TEEN
            // "female" содержит "male", поэтому женское проверяем первым
            femaleHints.any { n.contains(it) } -> return VoiceKind.FEMALE
            maleHints.any { n.contains(it) } -> return VoiceKind.MALE
        }

        // 3) таблица кодов Google Speech Services
        googleCode(v.name)?.let { code ->
            if (code in googleFemaleCodes) return VoiceKind.FEMALE
            if (code in googleMaleCodes) return VoiceKind.MALE
        }

        return VoiceKind.OTHER
    }

    /**
     * Голос для роли. Если движок не даёт распознать пол (частый случай для
     * Google-кодов вне таблицы), голоса всё равно РАЗВОДЯТСЯ: женским ролям
     * достаётся первый нераспознанный, мужским — следующий. Так в сцене
     * звучат разные голоса, даже когда пол формально неизвестен.
     */
    fun pick(
        tts: TextToSpeech?,
        kind: VoiceKind,
        exactName: String?,
        enginePackage: String? = null,
    ): Voice? = pickFor(tts, kind, exactName, "ru", enginePackage)

    fun pickFor(
        tts: TextToSpeech?,
        kind: VoiceKind,
        exactName: String?,
        language: String,
        enginePackage: String? = null,
    ): Voice? {
        val all = voicesFor(tts, language, enginePackage)
        if (all.isEmpty()) return null
        if (!exactName.isNullOrBlank()) all.find { it.name == exactName }?.let { return it }

        // Локальные голоса предпочтительнее сетевых: работают без интернета.
        val ranked = all.sortedWith(compareBy({ it.isNetworkConnectionRequired }, { it.name }))
        val group = ranked.filter { classify(it) == kind }
        if (group.isNotEmpty()) {
            val preferred = when (kind) {
                VoiceKind.FEMALE -> group.firstOrNull { it.name.contains("svetlana", true) }
                VoiceKind.MALE -> group.firstOrNull { it.name.contains("dmitr", true) }
                else -> null
            }
            return preferred ?: group.first()
        }

        // Пол не определён — разводим роли по разным голосам детерминированно.
        val unknown = ranked.filter { classify(it) == VoiceKind.OTHER }
        val pool = unknown.ifEmpty { ranked }
        val index = when (kind) {
            VoiceKind.FEMALE -> 0
            VoiceKind.MALE -> 1
            VoiceKind.TEEN -> 2
            VoiceKind.OTHER -> 0
        }
        return pool.getOrNull(index % pool.size) ?: pool.firstOrNull()
    }

    /**
     * Отдельный голос на говорящего: разные персонажи одного пола получают
     * разные голоса из своей группы (по кругу), чтобы диалог не звучал
     * одинаково. [speakerSlot] — порядковый номер персонажа в сцене.
     */
    fun pickForSpeaker(
        tts: TextToSpeech?,
        kind: VoiceKind,
        speakerSlot: Int,
        language: String = "ru",
        enginePackage: String? = null,
    ): Voice? {
        val all = voicesFor(tts, language, enginePackage)
        if (all.isEmpty()) return null
        val ranked = all.sortedWith(compareBy({ it.isNetworkConnectionRequired }, { it.name }))
        val group = ranked.filter { classify(it) == kind }
        val pool = when {
            group.isNotEmpty() -> group
            else -> ranked.filter { classify(it) == VoiceKind.OTHER }.ifEmpty { ranked }
        }
        if (pool.isEmpty()) return null
        val offset = if (group.isEmpty()) {
            when (kind) {
                VoiceKind.MALE -> 1
                VoiceKind.TEEN -> 2
                else -> 0
            }
        } else {
            0
        }
        return pool[(offset + speakerSlot.coerceAtLeast(0)) % pool.size]
    }
}

/**
 * ЛОКАЛЬНЫЙ AI-помощник выбора голосов (по запросу пользователя: «внутренний
 * json АИ помогает с выбором голосов локально»). Никакой сети: правила в
 * JSON-файле /sdcard/Yomikai/AI/voice_rules.json, который можно править
 * руками или попросить AI-агента (write_file/edit_file). Формат:
 * {
 *   "rules": [
 *     {"contains": "имя_персонажа", "voice": "имя-голоса-или-id"},
 *     {"gender": "female", "engine": "onnx", "voice": "irina"}
 *   ]
 * }
 * recommend() применяет правила к тексту реплики и полу говорящего.
 */
object LocalVoiceAdvisor {

    data class Advice(val voiceName: String?, val onnxVoiceId: String?)

    private fun rulesFile(): java.io.File =
        java.io.File(
            android.os.Environment.getExternalStorageDirectory(),
            "Yomikai/AI/voice_rules.json",
        )

    fun recommend(text: String, gender: String?): Advice {
        val f = rulesFile()
        if (!f.isFile) return Advice(null, null)
        return runCatching {
            val root = org.json.JSONObject(f.readText())
            val rules = root.optJSONArray("rules") ?: return Advice(null, null)
            for (i in 0 until rules.length()) {
                val r = rules.optJSONObject(i) ?: continue
                val contains = r.optString("contains")
                val g = r.optString("gender")
                val matches =
                    (contains.isNotBlank() && text.contains(contains, ignoreCase = true)) ||
                        (contains.isBlank() && g.isNotBlank() && g == gender)
                if (matches) {
                    val voice = r.optString("voice")
                    return if (r.optString("engine") == "onnx") {
                        Advice(null, voice.ifBlank { null })
                    } else {
                        Advice(voice.ifBlank { null }, null)
                    }
                }
            }
            Advice(null, null)
        }.getOrDefault(Advice(null, null))
    }

    /** Есть ли файл правил (для подсказки в UI). */
    fun hasRules(): Boolean = rulesFile().isFile
}
