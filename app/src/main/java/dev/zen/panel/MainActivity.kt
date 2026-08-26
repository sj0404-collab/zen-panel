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
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import org.json.JSONObject

/**
 * The Zen Panel, served from inside the APK.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var bar: ProgressBar
    private lateinit var errorView: LinearLayout

    private val assets_ by lazy { PanelAssets(this) }

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

        web.setDownloadListener { url, _, _, mime, _ ->
            runCatching {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                    )
                    setMimeType(mime)
                }
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Скачивается…", Toast.LENGTH_SHORT).show()
            }.onFailure {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
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
