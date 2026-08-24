plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun git(vararg args: String): String? = try {
    val p = ProcessBuilder(listOf("git") + args).directory(rootProject.projectDir).redirectErrorStream(true).start()
    val out = p.inputStream.bufferedReader().readText().trim()
    if (p.waitFor() == 0 && out.isNotEmpty()) out else null
} catch (_: Exception) { null }

val buildNumber = git("rev-list", "--count", "HEAD")?.toIntOrNull() ?: 1
val buildSha = git("rev-parse", "--short", "HEAD") ?: "dev"

android {
    namespace = "dev.zen.panel"
    compileSdk = 34
    defaultConfig {
        applicationId = "dev.zen.panel"
        minSdk = 24
        targetSdk = 34
        versionCode = buildNumber
        versionName = "$buildNumber.$buildSha"
        buildConfigField("String", "PANEL_VERSION", "\"$buildNumber.$buildSha\"")
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("debug") }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies { implementation("androidx.activity:activity-ktx:1.9.2") }
