package tachiyomi.core.common.util.system

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * Есть ли сейчас сеть с доступом в интернет.
 *
 * Одна реализация на всё приложение: её используют реестры плагинов
 * (OCR, голосовые, AI-бэкенды) и экраны настроек. Раньше проверка была
 * закомпозишена внутри экрана настроек, и любой не-UI код был вынужден либо
 * дублировать её, либо жить без статуса доступности.
 *
 * Намеренно НЕ подписывается на `registerNetworkCallback`: реестрам достаточно
 * снимка на момент входа в экран, а живое наблюдение остаётся за UI.
 */
fun isNetworkAvailable(context: Context): Boolean = runCatching {
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val capabilities = connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
    capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
}.getOrDefault(false)
