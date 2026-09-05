package eu.kanade.tachiyomi.data.tts

import android.content.Context
import android.speech.tts.TextToSpeech
import mihon.domain.ocr.service.OcrPreferences
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Продвинутый резолвер голосов: 1 / 2 / 3 голоса.
 *
 * Запрос пользователя:
 *  - 1 голос — один нарратор (выбор муж/жен) озвучивает всё
 *  - 2 голоса — мужской и женский (локальный или онлайн) по полу реплики
 *  - 3 голоса — муж + жен + нарратор (отдельный выбор)
 *
 *Каждый из трёх слотов имеет свой движок:
 *  - `pref_voice_male_engine`  → male
 *  - `pref_voice_female_engine`→ female
 *  - `pref_voice_narrator_engine` → narrator
 *и свой голос внутри движка (`pref_voice_male`, `pref_voice_female`, `pref_voice_name` для нарратора).
 *
 * Логика [resolve] применяется в [TtsSpeaker.speakAs] и [AutoReadEngine].
 */
object VoiceModeResolver {

    enum class Mode(val id: String, val title: String, val desc: String) {
        SINGLE("single", "Один голос", "Весь текст — голосом нарратора"),
        DUAL("dual", "Два голоса", "Мужские реплики — мужским, женские — женским"),
        TRIPLE("triple", "Три голоса", "Муж + Жен + Нарратор (описания, ремарки)"),
        ;

        companion object {
            fun fromId(id: String?): Mode = entries.firstOrNull { it.id == id } ?: DUAL
        }
    }

    data class ResolvedVoice(
        val gender: String, // male | female | narrator
        val engine: String, // system_tts | google_web | remote_tts | eleven_api
        val voiceName: String,
        val isLocal: Boolean,
        val isOnline: Boolean,
    )

    private fun prefs(): OcrPreferences = Injekt.get()

    fun currentMode(): Mode = Mode.fromId(prefs().voiceMode().get())

    fun narratorGender(): String = prefs().narratorGender().get().lowercase().let {
        when (it) {
            "male", "female" -> it
            else -> "female" // auto → female по умолчанию
        }
    }

    /**
     * Выбрать голос для реплики с учётом режима и пола, определённого
     * морфологией/AI (female/male/null).
     *
     * @param detectedGender пол реплики от RuMorph/AI: "female"|"male"|null
     * @param isNarration был ли текст помечен как нарратив (без кавычек, описания)
     */
    fun resolve(
        detectedGender: String?,
        isNarration: Boolean = false,
        speakerSlot: Int = 0,
    ): ResolvedVoice {
        val mode = currentMode()
        val p = prefs()

        return when (mode) {
            Mode.SINGLE -> {
                val g = narratorGender()
                val engine = p.voiceNarratorEngine().get().ifBlank { p.voiceEngine().get() }
                val name = when (g) {
                    "male" -> p.voiceMale().get().ifBlank { p.voiceName().get() }
                    else -> p.voiceFemale().get().ifBlank { p.voiceName().get() }
                }
                ResolvedVoice(
                    gender = g,
                    engine = engine,
                    voiceName = name,
                    isLocal = engine == TtsSpeaker.ENGINE_SYSTEM || engine == TtsSpeaker.ENGINE_REMOTE,
                    isOnline = engine == TtsSpeaker.ENGINE_GOOGLE_WEB || engine == TtsSpeaker.ENGINE_ELEVENLABS,
                )
            }
            Mode.DUAL -> {
                val g = detectedGender ?: narratorGender()
                val isMale = g == "male"
                val engine = if (isMale) p.voiceMaleEngine().get() else p.voiceFemaleEngine().get()
                val fallbackEngine = p.voiceEngine().get()
                val effEngine = engine.ifBlank { fallbackEngine }
                val name = if (isMale) p.voiceMale().get() else p.voiceFemale().get()
                ResolvedVoice(
                    gender = g,
                    engine = effEngine.ifBlank { TtsSpeaker.ENGINE_SYSTEM },
                    voiceName = name,
                    isLocal = effEngine == TtsSpeaker.ENGINE_SYSTEM || effEngine == TtsSpeaker.ENGINE_REMOTE,
                    isOnline = effEngine == TtsSpeaker.ENGINE_GOOGLE_WEB,
                )
            }
            Mode.TRIPLE -> {
                if (isNarration) {
                    val g = narratorGender()
                    val engine = p.voiceNarratorEngine().get().ifBlank { p.voiceEngine().get() }
                    val name = when (g) {
                        "male" -> p.voiceMale().get().ifBlank { p.voiceName().get() }
                        else -> p.voiceFemale().get().ifBlank { p.voiceName().get() }
                    }
                    ResolvedVoice(g, engine.ifBlank { TtsSpeaker.ENGINE_SYSTEM }, name, true, false)
                } else {
                    val g = detectedGender ?: "female"
                    val isMale = g == "male"
                    val engine = if (isMale) p.voiceMaleEngine().get() else p.voiceFemaleEngine().get()
                    val name = if (isMale) p.voiceMale().get() else p.voiceFemale().get()
                    ResolvedVoice(g, engine.ifBlank { TtsSpeaker.ENGINE_SYSTEM }, name, true, false)
                }
            }
        }
    }

    fun describeCurrent(): String {
        val mode = currentMode()
        val p = prefs()
        return when (mode) {
            Mode.SINGLE -> "Один голос: нарратор ${narratorGender()} (${p.voiceNarratorEngine().get().ifBlank { p.voiceEngine().get() }})"
            Mode.DUAL -> "Два голоса: муж (${p.voiceMaleEngine().get().ifBlank { "system_tts" }}) + жен (${p.voiceFemaleEngine().get().ifBlank { "system_tts" }})"
            Mode.TRIPLE -> "Три голоса: муж (${p.voiceMaleEngine().get()}) + жен (${p.voiceFemaleEngine().get()}) + нарратор ${narratorGender()} (${p.voiceNarratorEngine().get()})"
        }
    }

    /**
     * Применить resolved-голос к TextToSpeech: setVoice + rate/pitch от VoicePreset.
     */
    fun applyToTts(
        tts: TextToSpeech?,
        resolved: ResolvedVoice,
        rate: Float,
        pitch: Float,
    ) {
        if (tts == null) return
        val kind = when (resolved.gender) {
            "male" -> VoiceKind.MALE
            "female" -> VoiceKind.FEMALE
            else -> VoiceKind.OTHER
        }
        val voice = VoiceHelper.pickFor(tts, kind, resolved.voiceName.takeIf { it.isNotBlank() }, "ru", null)
        if (voice != null) {
            runCatching { tts.voice = voice }
        }
        tts.setSpeechRate(rate)
        tts.setPitch(pitch)
    }
}
