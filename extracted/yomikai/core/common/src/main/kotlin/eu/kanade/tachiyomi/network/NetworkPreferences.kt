package eu.kanade.tachiyomi.network

import tachiyomi.core.common.preference.Preference
import tachiyomi.core.common.preference.PreferenceStore

class NetworkPreferences(
    preferenceStore: PreferenceStore,
    verboseLoggingDefault: Boolean = false,
) {

    val verboseLogging: Preference<Boolean> = preferenceStore.getBoolean("verbose_logging", verboseLoggingDefault)

    val dohProvider: Preference<Int> = preferenceStore.getInt("doh_provider", -1)

    val defaultUserAgent: Preference<String> = preferenceStore.getString(
        "default_user_agent",
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    )

    // Proxy Settings
    val enableProxy: Preference<Boolean> = preferenceStore.getBoolean("pref_enable_proxy", false)
    val proxyType: Preference<Int> = preferenceStore.getInt("pref_proxy_type", 0) // 0 = HTTP, 1 = SOCKS
    val proxyHost: Preference<String> = preferenceStore.getString("pref_proxy_host", "")
    val proxyPort: Preference<Int> = preferenceStore.getInt("pref_proxy_port", 8080)
    val proxyUser: Preference<String> = preferenceStore.getString("pref_proxy_user", "")
    val proxyPassword: Preference<String> = preferenceStore.getString("pref_proxy_password", "")
}
