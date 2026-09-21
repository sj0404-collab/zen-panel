// SPDX-FileCopyrightText: Copyright 2026 Symbiosis Project
// SPDX-License-Identifier: GPL-3.0-or-later

package dev.zen.hub

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.ValueCallback
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.net.URLDecoder

/**
 * NPM Hub: a connect page served from inside the APK, then the hub itself.
 *
 * The connect page (assets/hub/index.html) dispatches the hub workflow with a
 * gate token it generates, polls the session branch for the tunnel address and
 * navigates this WebView to it. Everything after that is the hub's own /m app.
 * There is no JS bridge: the /m app uses none, and the connect page needs none.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var bar: ProgressBar
    private lateinit var errorView: LinearLayout

    private val assets_ by lazy { HubAssets(this) }

    // <input type=file> in the hub's /m file manager: without this the
    // upload button silently does nothing in a WebView.
    private var fileChooser: ValueCallback<Array<android.net.Uri>>? = null
    private val filePicker =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val uris = WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data)
                ?: emptyArray()
            fileChooser?.onReceiveValue(uris)
            fileChooser = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
        }

        bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 6)
            visibility = View.GONE
        }

        web = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
            setBackgroundColor(BACKGROUND)
        }

        errorView = buildErrorView()

        root.addView(bar)
        root.addView(web)
        root.addView(errorView)
        setContentView(root)

        configureWebView()
        registerBackHandler()

        if (savedInstanceState == null) web.loadUrl(HUB_URL)
        else web.restoreState(savedInstanceState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString NpmHub/$SHELL_VERSION"
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                bar.progress = newProgress
                bar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                view: WebView?, callback: ValueCallback<Array<android.net.Uri>>?,
                params: WebChromeClient.FileChooserParams?
            ): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                return try {
                    val intent = params?.createIntent()
                    if (intent == null) {
                        fileChooser = null
                        false
                    } else {
                        filePicker.launch(intent)
                        true
                    }
                } catch (e: Exception) {
                    fileChooser = null
                    false
                }
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ) = assets_.serve(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                val host = url.host ?: return false
                // The hub tunnel stays in the app; anything else is a real
                // browser's job.
                if (isInternal(host)) return false
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                }.getOrElse {
                    Toast.makeText(
                        this@MainActivity, "Нечем открыть: $url", Toast.LENGTH_SHORT
                    ).show()
                    true
                }
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, err: WebResourceError
            ) {
                if (!request.isForMainFrame) return
                showError()
            }

            override fun onPageFinished(view: WebView, url: String) {
                bar.visibility = View.GONE
                val js = "window.ZEN_HUB_BUILD={versionCode:${BuildConfig.HUB_VERSION_CODE}," +
                    "versionName:${JSONObject.quote(BuildConfig.HUB_VERSION)};" +
                    "if(window.onZenHubBuild)window.onZenHubBuild(window.ZEN_HUB_BUILD);"
                view.evaluateJavascript(js, null)
            }
        }

        web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            runCatching {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                    )
                    // Android guesses filenames from URL+MIME and mangles real
                    // extensions (apk → .bin / .ts1). Use the server's filename
                    // from Content-Disposition and store into Downloads with it.
                    val name = dispositionFilename(contentDisposition) ?: urlFilename(url)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, name
                    )
                    val detectedMime = mimeType?.takeUnless { it.isBlank() || it == "application/octet-stream" }
                        ?: mimeForName(name)
                    setMimeType(detectedMime)
                }
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Скачивается…", Toast.LENGTH_SHORT).show()
            }.onFailure {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        }
    }

    // Prefer RFC 5987 filename*=, then the legacy filename=. This preserves
    // compound names such as app.tar.xz and release.apk instead of letting
    // DownloadManager invent a .bin/.ts extension from the MIME type.
    private fun dispositionFilename(cd: String?): String? {
        if (cd.isNullOrBlank()) return null
        val encoded = Regex("""filename\*\s*=\s*UTF-8''([^;]+)""", RegexOption.IGNORE_CASE)
            .find(cd)?.groupValues?.getOrNull(1)
        val plain = Regex("""filename\s*=\s*(?:"([^"]+)"|([^;]+))""", RegexOption.IGNORE_CASE)
            .find(cd)?.let { it.groupValues[1].ifBlank { it.groupValues[2] } }
        var name = (encoded?.let { runCatching { URLDecoder.decode(it.trim(), "UTF-8") }.getOrNull() }
            ?: plain)?.trim()?.trim('"')
        if (name.isNullOrBlank() || name.equals("download", ignoreCase = true)) return null
        name = name.replace(Regex("""[/\\:*?"<>|%{}]"""), "_").trim()
        return name.ifBlank { null }
    }

    private fun urlFilename(url: String?): String {
        val clean = url?.substringBefore('?') ?: return "download.bin"
        val raw = clean.substringAfterLast('/').ifBlank { return "download.bin" }
        return runCatching { URLDecoder.decode(raw, "UTF-8") }
            .getOrDefault(raw).replace(Regex("""[/\\:*?"<>|%{}]"""), "_")
            .ifBlank { "download.bin" }
    }

    private fun mimeForName(name: String): String {
        val lower = name.lowercase()
        return when {
            lower.endsWith(".apk") -> "application/vnd.android.package-archive"
            lower.endsWith(".aab") -> "application/octet-stream"
            lower.endsWith(".apks") || lower.endsWith(".xapk") -> "application/zip"
            lower.endsWith(".tar.xz") -> "application/x-xz"
            lower.endsWith(".tar.gz") || lower.endsWith(".tgz") -> "application/gzip"
            lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2") -> "application/x-bzip2"
            lower.endsWith(".tar.zst") || lower.endsWith(".tzst") -> "application/zstd"
            lower.endsWith(".tar") -> "application/x-tar"
            lower.endsWith(".xz") -> "application/x-xz"
            lower.endsWith(".gz") -> "application/gzip"
            lower.endsWith(".bz2") -> "application/x-bzip2"
            lower.endsWith(".zst") -> "application/zstd"
            lower.endsWith(".zip") -> "application/zip"
            lower.endsWith(".7z") -> "application/x-7z-compressed"
            lower.endsWith(".rar") -> "application/vnd.rar"
            lower.endsWith(".deb") -> "application/vnd.debian.binary-package"
            lower.endsWith(".rpm") -> "application/x-rpm"
            lower.endsWith(".jar") -> "application/java-archive"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".xml") -> "application/xml"
            lower.endsWith(".html") || lower.endsWith(".htm") -> "text/html"
            lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log") -> "text/plain"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".mp3") -> "audio/mpeg"
            else -> "application/octet-stream"
        }
    }

    private fun buildErrorView(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        setPadding(56, 56, 56, 56)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        addView(TextView(context).apply {
            text = "Хаб не открылся"
            setTextColor(Color.WHITE)
            textSize = 19f
        })
        addView(TextView(context).apply {
            text = "Проверьте соединение. Если хаб только запущен — подождите " +
                "минуту: адрес появляется не сразу."
            setTextColor(Color.parseColor("#8a8a9e"))
            textSize = 14f
            setPadding(0, 16, 0, 24)
        })
        addView(android.widget.Button(context).apply {
            text = "Повторить"
            setOnClickListener {
                errorView.visibility = View.GONE
                web.visibility = View.VISIBLE
                // Back to the connect page, not the dead tunnel: it can
                // relaunch or reopen from there.
                web.loadUrl(HUB_URL)
            }
        })
    }

    private fun showError() {
        web.visibility = View.GONE
        errorView.visibility = View.VISIBLE
        bar.visibility = View.GONE
    }

    private fun registerBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack()
                else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private val INTERNAL_SUFFIXES = listOf(
            "trycloudflare.com",
            "cfargotunnel.com",
            "ngrok-free.app",
            "ngrok.io",
            "ngrok.app",
            "github.io"
        )

        fun isInternal(host: String?): Boolean {
            val h = host?.lowercase() ?: return false
            if (h == HUB_HOST) return true
            return INTERNAL_SUFFIXES.any { h == it || h.endsWith(".$it") }
        }

        const val HUB_HOST = "hub.symbiosis.local"
        const val HUB_URL = "https://$HUB_HOST/index.html"
        val SHELL_VERSION: String = BuildConfig.HUB_VERSION
        private val BACKGROUND = Color.parseColor("#0d0d12")
    }
}
