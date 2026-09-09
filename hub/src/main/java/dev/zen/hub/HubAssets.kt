// SPDX-FileCopyrightText: Copyright 2026 Symbiosis Project
// SPDX-License-Identifier: GPL-3.0-or-later

package dev.zen.hub

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Answers the hub shell's own requests out of `assets/hub/`.
 *
 * Same split as the panel APK: URLs on [MainActivity.HUB_HOST] are answered
 * from the APK, everything else returns null and goes to the network as usual.
 * The connect page is one inlined HTML file, so this stays deliberately small.
 */
class HubAssets(private val context: Context) {

    /**
     * @return a response read from the APK, or null to let the network handle it.
     */
    fun serve(url: Uri?): WebResourceResponse? {
        if (url == null) return null
        if (!url.host.equals(MainActivity.HUB_HOST, ignoreCase = true)) return null

        val name = fileNameFor(url) ?: return notFound()
        if (name == "version.json") {
            val json = """{"versionCode":${dev.zen.hub.BuildConfig.HUB_VERSION_CODE},"versionName":"${dev.zen.hub.BuildConfig.HUB_VERSION}","applicationId":"dev.zen.hub"}"""
            return WebResourceResponse(
                "application/json", "utf-8", 200, "OK", headers(),
                ByteArrayInputStream(json.toByteArray(Charsets.UTF_8))
            )
        }
        return try {
            val stream: InputStream = context.assets.open("$ASSET_DIR/$name")
            WebResourceResponse(mimeFor(name), "utf-8", 200, "OK", headers(), stream)
        } catch (e: IOException) {
            notFound()
        }
    }

    private fun fileNameFor(url: Uri): String? {
        val path = url.path.orEmpty().trimStart('/')
        if (path.isEmpty()) return "index.html"

        // No traversal, no subdirectories: a flat set of files.
        if (path.contains("..") || path.contains('/') || path.contains('\\')) return null
        if (!ALLOWED.contains(path)) return null
        return path
    }

    private fun mimeFor(name: String): String = when {
        name.endsWith(".html") -> "text/html"
        name.endsWith(".js") -> "application/javascript"
        name.endsWith(".css") -> "text/css"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".json") || name.endsWith(".webmanifest") -> "application/json"
        name.endsWith(".png") -> "image/png"
        else -> "application/octet-stream"
    }

    private fun headers(): Map<String, String> = mapOf(
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff"
    )

    private fun notFound(): WebResourceResponse = WebResourceResponse(
        "text/html", "utf-8", 404, "Not Found", headers(),
        ByteArrayInputStream(MISSING.toByteArray(Charsets.UTF_8))
    )

    companion object {
        /** Where the pages sit inside the APK. */
        const val ASSET_DIR = "hub"

        val ALLOWED = setOf(
            "index.html"
        )

        private const val MISSING =
            "<!doctype html><meta charset=utf-8>" +
                "<body style=\"background:#0d0d12;color:#e8e8f0;font:15px sans-serif;padding:24px\">" +
                "<h3>Страница не входит в сборку</h3>" +
                "<p style=\"color:#8a8a9e\">Этот файл не был упакован в APK. " +
                "Переустановите приложение.</p>"
    }
}
