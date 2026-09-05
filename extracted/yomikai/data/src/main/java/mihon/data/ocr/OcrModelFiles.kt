package mihon.data.ocr

import android.content.Context
import android.os.Environment
import java.io.File

/**
 * Resolves local OCR/vision model files installed OUTSIDE of the APK.
 *
 * The APK ships without any bundled models to stay lightweight: only online
 * engines work out of the box. Local models are optional and are loaded from
 * external storage when present.
 *
 * Search order for a model file (first match wins):
 * 1. App-scoped external dir (no permissions needed, filled by the in-app downloader):
 *    Android/data/app.yomihon/files/ocr_models/<flat name>
 * 2. Same dir with the asset-style sub-path: .../ocr_models/<sub/path>
 * 3. Legacy manual folders (best effort, may be unreadable on Android 11+):
 *    /sdcard/Yomihon/OCR/<flat name> and /sdcard/Download/Yomihon/OCR/<flat name>
 */
object OcrModelFiles {

    const val MODELS_DIR = "ocr_models"

    /** Maps asset-style paths to flat file names used in external folders and model packages. */
    private val flatNames = mapOf(
        "cyrillic_ocr/detector.tflite" to "cyrillic_detector.tflite",
        "cyrillic_ocr/recognizer_v3.tflite" to "cyrillic_recognizer_v3.tflite",
        "cyrillic_ocr/recognizer_v5.tflite" to "cyrillic_recognizer_v5.tflite",
        "cyrillic_ocr/dict_v3.txt" to "cyrillic_dict_v3.txt",
        "cyrillic_ocr/dict_v5.txt" to "cyrillic_dict_v5.txt",
        "ocr/encoder.tflite" to "encoder.tflite",
        "ocr/decoder.tflite" to "decoder.tflite",
        "ocr/embeddings.bin" to "embeddings.bin",
        "ocr_fast/encoder.tflite" to "encoder_fast.tflite",
        "ocr_fast/decoder.tflite" to "decoder_fast.tflite",
        "panel_detector/model.tflite" to "panel_detector.tflite",
    )

    /**
     * Returns an absolute readable file path for the given asset-style model path,
     * or null when the model is not installed externally.
     */
    fun resolve(context: Context, assetPath: String): String? {
        val flat = flatNames[assetPath] ?: File(assetPath).name

        val candidates = buildList {
            context.getExternalFilesDir(null)?.let { base ->
                add(File(File(base, MODELS_DIR), flat))
                add(File(File(base, MODELS_DIR), assetPath))
            }
            runCatching {
                val sdcard = Environment.getExternalStorageDirectory()
                add(File(File(sdcard, "Yomihon/OCR"), flat))
                add(
                    File(
                        File(
                            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                            "Yomihon/OCR",
                        ),
                        flat,
                    ),
                )
            }
        }

        return candidates.firstOrNull { it.isFile && it.canRead() && it.length() > 0 }?.absolutePath
    }

    /** True when every given asset-style path resolves to an installed external file. */
    fun allInstalled(context: Context, assetPaths: List<String>): Boolean {
        return assetPaths.all { resolve(context, it) != null }
    }

    /** Deletes externally installed files for the given asset-style paths (app dir only). */
    fun delete(context: Context, assetPaths: List<String>) {
        val base = context.getExternalFilesDir(null) ?: return
        val dir = File(base, MODELS_DIR)
        assetPaths.forEach { assetPath ->
            val flat = flatNames[assetPath] ?: File(assetPath).name
            File(dir, flat).delete()
            File(dir, assetPath).delete()
        }
    }
}
