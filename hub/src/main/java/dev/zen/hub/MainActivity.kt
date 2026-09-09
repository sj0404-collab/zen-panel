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
                    filePicker.launch(params?.createIntent())
                    true
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
