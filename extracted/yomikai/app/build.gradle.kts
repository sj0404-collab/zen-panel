import mihon.gradle.Config
import mihon.gradle.getBuildTime
import mihon.gradle.getLatestCommitCount
import mihon.gradle.getLatestCommitSha
import mihon.gradle.tasks.ReplaceShortcutsPlaceholderTask
import java.io.FileInputStream
import java.util.Properties
import kotlin.io.encoding.Base64

plugins {
    alias(mihonx.plugins.android.application)
    alias(mihonx.plugins.compose)
    alias(mihonx.plugins.spotless)

    alias(libs.plugins.aboutLibraries)
    alias(libs.plugins.androidx.baselineProfile)
    alias(libs.plugins.kotlin.serialization)
}

if (Config.includeTelemetry) {
    pluginManager.apply {
        apply(libs.plugins.google.services.get().pluginId)
        apply(libs.plugins.firebase.crashlytics.get().pluginId)
    }
}

val keystorePropertiesFile = rootProject.file("keystore.properties")

android {
    namespace = "eu.kanade.tachiyomi"

    defaultConfig {
        applicationId = "app.yomihon"

        // Версия подтягивается из релизного тега автоматически (CI передаёт
        // RELEASE_TAG, напр. "v1.9.7" -> versionName 1.9.7, versionCode 10907).
        // Локальные сборки используют fallback ниже.
        val tagVersion = System.getenv("RELEASE_TAG")
            ?.removePrefix("v")
            ?.substringBefore("-")
            ?.takeIf { it.matches(Regex("""\d+\.\d+\.\d+""")) }
        val fallbackVersion = "0.8.0"
        val effectiveVersion = tagVersion ?: fallbackVersion
        val (vMajor, vMinor, vPatch) = effectiveVersion.split(".").map(String::toInt)

        // Android отказывается ставить APK, чей versionCode МЕНЬШЕ уже
        // установленного ("установлена более новая версия"). Такое уже
        // случалось: после тега v1.9.6 (10906) сборка по тегу v0.9.5 дала
        // 905, и APK перестал устанавливаться поверх.
        //
        // Поэтому versionCode берётся как максимум из трёх величин:
        //  * значение из тега;
        //  * число коммитов (монотонно растёт);
        //  * MIN_VERSION_CODE — планка выше всех уже выпущенных сборок.
        // Планку поднимать при каждом мажорном релизе; она гарантирует, что
        // случайный старый тег не выпустит APK ниже установленного.
        val versionFromTag = vMajor * 10000 + vMinor * 100 + vPatch
        val commitCount = getLatestCommitCount().toIntOrNull() ?: 0
        val minVersionCode = 10907 // v1.9.7 — последняя опубликованная сборка
        versionCode = maxOf(versionFromTag, commitCount, minVersionCode)
        versionName = effectiveVersion

        buildConfigField("String", "COMMIT_COUNT", "\"${getLatestCommitCount()}\"")
        buildConfigField("String", "COMMIT_SHA", "\"${getLatestCommitSha()}\"")
        buildConfigField("String", "BUILD_TIME", "\"${getBuildTime(useLatestCommitTime = false)}\"")
        buildConfigField("boolean", "TELEMETRY_INCLUDED", "${Config.includeTelemetry}")
        buildConfigField("boolean", "UPDATER_ENABLED", "${Config.enableUpdater}")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Подписываем НАШИМ постоянным релиз-ключом всегда, когда он передан в env
    // (и в обычных CI-сборках, и в релизных). Раньше CI подписывал случайным
    // debug-ключом раннера — каждая сборка имела новую подпись, и приходилось
    // переустанавливать приложение вместо обновления поверх.
    if (!System.getenv("storeFileBase64").isNullOrBlank()) {
        val tempStoreFile = file(System.getenv("RUNNER_TEMP") ?: layout.buildDirectory.get().asFile.path)
            .resolve("antsy.keystore")

        val storeFileBytes = System.getenv("storeFileBase64").let(Base64::decode)
        tempStoreFile.outputStream().use { it.write(storeFileBytes) }

        signingConfigs {
            named("debug") {
                storeFile = tempStoreFile
                storePassword = System.getenv("storePassword")
                keyAlias = System.getenv("keyAlias")
                keyPassword = System.getenv("keyPassword")
            }
        }
    } else if (keystorePropertiesFile.exists()) {
        val keystoreProperties = FileInputStream(keystorePropertiesFile).use { Properties().apply { load(it) } }

        signingConfigs {
            named("debug") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        val debug = getByName("debug") {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-${getLatestCommitCount()}"
            isPseudoLocalesEnabled = true
        }
        val release = getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true

            signingConfig = debug.signingConfig

            isProfileable = true

            proguardFiles("proguard-android-optimize.txt", "proguard-rules.pro")

            buildConfigField("String", "BUILD_TIME", "\"${getBuildTime(useLatestCommitTime = true)}\"")
        }

        val commonMatchingFallbacks = listOf(release.name)

        create("foss") {
            initWith(release)

            applicationIdSuffix = ".foss"

            matchingFallbacks.addAll(commonMatchingFallbacks)
        }
        create("preview") {
            initWith(release)

            applicationIdSuffix = ".debug"

            versionNameSuffix = debug.versionNameSuffix

            matchingFallbacks.addAll(commonMatchingFallbacks)

            buildConfigField("String", "BUILD_TIME", "\"${getBuildTime(useLatestCommitTime = false)}\"")
        }
        create("benchmark") {
            initWith(release)

            versionNameSuffix = "-benchmark"
            applicationIdSuffix = ".benchmark"

            matchingFallbacks.addAll(commonMatchingFallbacks)
        }
    }

    sourceSets {
        getByName("preview").res.directories.add("src/debug/res")
        getByName("benchmark").res.directories.add("src/debug/res")
    }

    splits {
        abi {
            // Собираем ОДИН APK под arm64-v8a: это все актуальные телефоны.
            // Раньше выходило шесть файлов (v7a/arm64/x86/x86_64/universal/foss,
            // до 202 МБ каждый) — долгая сборка и путаница, какой ставить.
            // Вернуть остальные ABI: SPLIT_ALL_ABI=true.
            val allAbi = System.getenv("SPLIT_ALL_ABI") == "true"
            isEnable = true
            isUniversalApk = allAbi
            reset()
            if (allAbi) {
                include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
            } else {
                include("arm64-v8a")
            }
        }
    }

    packaging {
        jniLibs {
            keepDebugSymbols += listOf(
                "libandroidx.graphics.path",
                "libarchive-jni",
                "libconscrypt_jni",
                "libimagedecoder",
                "libquickjs",
                "libsqlite3x",
            )
                .map { "**/$it.so" }
        }
        resources {
            excludes += setOf(
                "kotlin-tooling-metadata.json",
                "LICENSE.txt",
                "META-INF/**/*.properties",
                "META-INF/**/LICENSE.txt",
                "META-INF/*.properties",
                "META-INF/*.version",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/NOTICE",
                "META-INF/README.md",
            )
        }
    }

    dependenciesInfo {
        includeInApk = Config.includeDependencyInfo
        includeInBundle = Config.includeDependencyInfo
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
        aidl = true
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    androidResources {
        noCompress.addAll(listOf("tflite", "bin"))
    }
}

kotlin {
    compilerOptions {
        freeCompilerArgs.addAll(
            "-opt-in=androidx.compose.animation.ExperimentalAnimationApi",
            "-opt-in=androidx.compose.animation.graphics.ExperimentalAnimationGraphicsApi",
            "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi",
            "-opt-in=androidx.compose.foundation.layout.ExperimentalLayoutApi",
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3ExpressiveApi",
            "-opt-in=androidx.compose.ui.ExperimentalComposeUiApi",
            "-opt-in=coil3.annotation.ExperimentalCoilApi",
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
            "-opt-in=kotlinx.coroutines.FlowPreview",
            "-opt-in=kotlinx.coroutines.InternalCoroutinesApi",
            "-opt-in=kotlinx.serialization.ExperimentalSerializationApi",
        )
    }
}

baselineProfile {
    baselineProfileOutputDir = "baselineProfiles"
    mergeIntoMain = true
}

dependencies {
    // Russian/Cyrillic PP-OCR models are downloaded outside the APK.
    // ONNX-голоса: только Java-API sherpa-onnx (238КБ, из classes.jar AAR).
    // Нативные .so (55МБ!) НЕ в APK — качаются как дополнение в рантайме
    // (OnnxTts.downloadRuntime) и грузятся через System.load.
    implementation(files("libs/sherpa-onnx-classes.jar"))
    implementation(libs.mediapipe.genai)
    implementation(libs.commons.compress)
    implementation(libs.xz)
    baselineProfile(projects.baselineProfile)

    implementation(projects.i18n)
    implementation(projects.core.archive)
    implementation(projects.core.common)
    implementation(projects.coreMetadata)
    implementation(projects.sourceApi)
    implementation(projects.sourceLocal)
    implementation(projects.data)
    implementation(projects.domain)
    implementation(projects.presentationCore)
    implementation(projects.presentationWidget)
    implementation(projects.telemetry)

    // Compose
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.materialIcons)
    implementation(libs.androidx.compose.animation)
    implementation(libs.androidx.compose.animationGraphics)
    debugImplementation(libs.androidx.compose.uiTooling)
    implementation(libs.androidx.compose.uiToolingPreview)
    implementation(libs.androidx.compose.uiUtil)

    implementation(libs.androidx.interpolator)

    implementation(libs.androidx.paging.runtime)
    implementation(libs.androidx.paging.compose)

    implementation(libs.androidx.sqlite.bundled)

    implementation(libs.kotlin.reflect)

    implementation(libs.bundles.kotlinx.coroutines)

    implementation(libs.sqldelight.async)

    // AndroidX libraries
    implementation(libs.androidx.annotation)
    implementation(libs.androidx.appCompat)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.constraintLayout)
    implementation(libs.androidx.core)
    implementation(libs.androidx.coreSplashScreen)
    implementation(libs.androidx.recyclerView)
    implementation(libs.androidx.viewPager)
    implementation(libs.androidx.profileInstaller)

    implementation(libs.bundles.androidx.lifecycle)

    // Job scheduling
    implementation(libs.androidx.work)

    // RxJava
    implementation(libs.rxJava)

    // Networking
    implementation(libs.bundles.okhttp)
    implementation(libs.okio)
    implementation(libs.conscrypt) // TLS 1.3 support for Android < 10

    // Data serialization (JSON, protobuf, xml)
    implementation(libs.bundles.serialization)

    // HTML parser
    implementation(libs.jsoup)

    // Disk
    implementation(libs.diskLruCache)
    implementation(libs.unifile)

    // Preferences
    implementation(libs.androidx.preference)

    // Dependency injection
    implementation(libs.injekt)

    // Image loading
    implementation(libs.bundles.coil)
    implementation(libs.subsamplingScaleImageView) {
        exclude(module = "image-decoder")
    }
    implementation(libs.image.decoder)

    // UI libraries
    implementation(libs.material)
    implementation(libs.flexibleAdapter)
    implementation(libs.photoView)
    implementation(libs.directionalViewPager) {
        exclude(group = "androidx.viewpager", module = "viewpager")
    }
    implementation(libs.composeRichEditor)
    implementation(libs.aboutLibraries.compose)
    implementation(libs.bundles.voyager)
    implementation(libs.composeMaterialMotion)
    implementation(libs.swipe)
    implementation(libs.composeWebview)
    implementation(libs.composeGrid)
    implementation(libs.reorderable)
    implementation(libs.bundles.markdown)
    implementation(libs.furiganable)
    implementation(libs.materialKolor)

    // Logging
    implementation(libs.logcat)

    // Shizuku
    implementation(libs.bundles.shizuku)

    // String similarity
    implementation(libs.stringSimilarity)

    // Tests
    testImplementation(libs.bundles.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
    testRuntimeOnly(libs.junit.platform.launcher)

    // For detecting memory leaks; see https://square.github.io/leakcanary/
    // debugImplementation(libs.leakCanary.android)
    implementation(libs.leakCanary.plumber)

    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.core.ktx)
    androidTestImplementation(libs.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}

androidComponents {
    onVariants { variant ->
        val resSource = variant.sources.res ?: return@onVariants

        val variantName = variant.name.replaceFirstChar { it.uppercase() }
        val replaceShortcutsPlaceholderTask = tasks.register<ReplaceShortcutsPlaceholderTask>(
            "replace${variantName}ShortcutPlaceholder",
        ) {
            applicationId.set(variant.applicationId)
            shortcutsFile.set(projectDir.resolve("src/main/shortcuts.xml"))
        }
        resSource.addGeneratedSourceDirectory(replaceShortcutsPlaceholderTask) { it.outputDir }
    }

    onVariants(selector().withFlavor("default" to "standard")) {
        // Only excluding in standard flavor because this breaks
        // Layout Inspector's Compose tree
        it.packaging.resources.excludes.add("META-INF/*.version")
    }
}

tasks.matching { it.name.startsWith("process") && it.name.contains("Manifest") }.configureEach {
    doFirst {
        inputs.files.files.forEach { file ->
            if (file.isDirectory) {
                file.walkTopDown().filter {
                    it.name == "AndroidManifest.xml" && it.path.contains("litert-api")
                }.forEach { xmlFile ->
                    val text = xmlFile.readText()
                    if (text.contains("package=\"com.google.ai.edge.litert\"")) {
                        xmlFile.writeText(
                            text.replace(
                                "package=\"com.google.ai.edge.litert\"",
                                "package=\"com.google.ai.edge.litert.api\"",
                            ),
                        )
                    }
                }
            } else if (file.name == "AndroidManifest.xml" && file.path.contains("litert-api")) {
                val text = file.readText()
                if (text.contains("package=\"com.google.ai.edge.litert\"")) {
                    file.writeText(
                        text.replace(
                            "package=\"com.google.ai.edge.litert\"",
                            "package=\"com.google.ai.edge.litert.api\"",
                        ),
                    )
                }
            }
        }
    }
}
