// SPDX-FileCopyrightText: Copyright 2026 Symbiosis Project
// SPDX-License-Identifier: GPL-3.0-or-later

package dev.zen.panel

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
 * The Zen Panel, served from inside the APK.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var bar: ProgressBar
    private lateinit var errorView: LinearLayout

    private val assets_ by lazy { PanelAssets(this) }

    // <input type=file> in the hub overlay (SAF): without onShowFileChooser
    // the upload button silently does nothing in a WebView.
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val filePicker =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val picked = ArrayList<Uri>()
            val clip = res.data?.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) picked.add(clip.getItemAt(i).uri)
            } else {
                res.data?.data?.let { picked.add(it) }
            }
            fileChooser?.onReceiveValue(picked.toTypedArray())
            fileChooser = null
        }

    // A notification tap can arrive before the panel JS has loaded. Queue it.
    private var pendingOpenSlot: String? = null
    private var pendingOpenUrl: String? = null
    private var pageReady = false

    private val startUrl: String
        get() = intent?.getStringExtra(EXTRA_URL)?.takeIf { it.isNotBlank() } ?: PANEL_URL

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
        ensureNotificationChannel()
        captureOpenIntent(intent)

        if (savedInstanceState == null) web.loadUrl(startUrl)
        else web.restoreState(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureOpenIntent(intent)
        if (pageReady) flushPendingOpen()
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
            userAgentString = "$userAgentString ZenPanel/$SHELL_VERSION"
        }

        web.addJavascriptInterface(ZenBridge(this), "ZenBridge")

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            web.setBackgroundColor(BACKGROUND)
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                bar.progress = newProgress
                bar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                view: WebView?, callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                return try {
                    val intent = params?.createIntent()
                    if (intent == null) {
                        fileChooser = null
                        false
                    } else {
                        if (params?.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
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
            ): WebResourceResponse? = assets_.serve(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                val host = url.host ?: return false
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
                pageReady = true
                val js = "window.ZEN_PANEL_BUILD={versionCode:${BuildConfig.PANEL_VERSION_CODE}," +
                    "versionName:${JSONObject.quote(BuildConfig.PANEL_VERSION)}};" +
                    "if(window.onZenPanelBuild)window.onZenPanelBuild(window.ZEN_PANEL_BUILD);"
                view.evaluateJavascript(js, null)
                flushPendingOpen()
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

    private fun captureOpenIntent(intent: Intent?) {
        val slot = intent?.getStringExtra(EXTRA_OPEN_SLOT)?.takeIf { it.isNotBlank() } ?: return
        pendingOpenSlot = slot
        pendingOpenUrl = intent.getStringExtra(EXTRA_OPEN_URL) ?: ""
    }

    private fun flushPendingOpen() {
        val slot = pendingOpenSlot ?: return
        val url = pendingOpenUrl ?: ""
        pendingOpenSlot = null
        pendingOpenUrl = null
        val js = "if(window.zenOpenFromNotify)window.zenOpenFromNotify(" +
            JSONObject.quote(slot) + "," + JSONObject.quote(url) + ");"
        web.evaluateJavascript(js, null)
    }

    fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }

    // Открыть адрес в СИСТЕМНОМ браузере телефона. Нужен для кнопки «Браузер»
    // в панели: внутри WebView.window.open() просто navigates сам WebView
    // (shouldOverrideUrlLoading с host панели считает внутренним), а
    // ACTION_VIEW уводит страницу в отдельное приложение, которое переживает
    // перезапуск нашего APK вместе с открытой вкладкой.
    fun openInSystemBrowser(url: String?) {
        val target = url?.trim().orEmpty()
        if (target.isEmpty()) return
        val uri = runCatching { Uri.parse(target) }.getOrNull()
        if (uri == null || uri.scheme.isNullOrBlank()) {
            Toast.makeText(this, "Некорректный адрес: $target", Toast.LENGTH_SHORT).show()
            return
        }
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        }.onFailure {
            Toast.makeText(this, "Нечем открыть: $target", Toast.LENGTH_SHORT).show()
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID, "Сессии", NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Чат готов — открыть из уведомления"
                enableVibration(true)
            }
        )
    }

    fun showSessionNotification(title: String, body: String, slot: String, url: String) {
        ensureNotificationChannel()
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            ensureNotificationPermission()
            return
        }
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_SLOT, slot)
            putExtra(EXTRA_OPEN_URL, url)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val tap = PendingIntent.getActivity(this, slot.hashCode(), open, flags)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            Notification.Builder(this)
        val n = builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .addAction(0, "Открыть чат", tap)
            .build()
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(1000 + (slot.hashCode() and 0xff), n)
    }

    private fun buildErrorView(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        setPadding(56, 56, 56, 56)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        addView(TextView(context).apply {
            text = "Панель не открылась"
            setTextColor(Color.WHITE)
            textSize = 19f
        })
        addView(TextView(context).apply {
            text = "Страница входит в состав приложения, поэтому связь тут ни при чём. " +
                "Похоже, сборка повреждена — переустановите APK."
            setTextColor(Color.parseColor("#8a8a9e"))
            textSize = 14f
            setPadding(0, 16, 0, 24)
        })
        addView(android.widget.Button(context).apply {
            text = "Повторить"
            setOnClickListener {
                errorView.visibility = View.GONE
                web.visibility = View.VISIBLE
                web.loadUrl(startUrl)
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
            if (h == PANEL_HOST) return true
            return INTERNAL_SUFFIXES.any { h == it || h.endsWith(".$it") }
        }

        const val PANEL_HOST = "panel.symbiosis.local"
        const val PANEL_URL = "https://$PANEL_HOST/index.html"
        const val EXTRA_URL = "panel_url"
        const val EXTRA_OPEN_SLOT = "open_slot"
        const val EXTRA_OPEN_URL = "open_url"
        const val CHANNEL_ID = "session-ready"
        val SHELL_VERSION: String = BuildConfig.PANEL_VERSION
        private val BACKGROUND = Color.parseColor("#0d0d12")
    }
}
