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
        versionName = "1.$buildNumber.$buildSha"
        buildConfigField("int", "PANEL_VERSION_CODE", "$buildNumber")
        buildConfigField("String", "PANEL_VERSION", "\"1.$buildNumber.$buildSha\"")
    }
    buildFeatures { buildConfig = true }
    // One keystore for every CI APK so "install over previous" works.
    // Secrets ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD override this
    // bundled sideload key if set.
    val uploadStore = file("keystore/upload.jks")
    val storePass = System.getenv("ANDROID_KEYSTORE_PASSWORD").orEmpty().ifBlank { "zenpanel-upload" }
    val keyAlias = System.getenv("ANDROID_KEY_ALIAS").orEmpty().ifBlank { "zen-panel" }
    val keyPass = System.getenv("ANDROID_KEY_PASSWORD").orEmpty().ifBlank { storePass }
    if (uploadStore.exists()) {
        signingConfigs.create("release") {
            storeFile = uploadStore
            storePassword = storePass
            this.keyAlias = keyAlias
            keyPassword = keyPass
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies { implementation("androidx.activity:activity-ktx:1.9.2") }
