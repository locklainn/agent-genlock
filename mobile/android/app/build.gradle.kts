import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.locklainn.genlock"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.locklainn.genlock"
        minSdk = 26
        targetSdk = 34
        // Minutes since 2026-01-01: every build is newer than the last, so a shipped APK
        // (mobile/ship_android.sh) installs over the one already on the phone.
        versionCode = ((System.currentTimeMillis() / 1000 - 1767225600) / 60).toInt()
        versionName = "0.1." + versionCode
        // The voice engine's native code is per ABI; the Pixel is arm64. Others would add ~70 MB.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // The Genlock voice on the phone (PhoneVoice.kt): sherpa-onnx 1.13.8, the version the Mac runs.
    // Stay on 1.13.8: 2.x ignores espeak-ng-data, so unknown words would be said differently from the Mac.
    implementation(files("libs/sherpa-onnx-1.13.8.aar"))
    // Google's own QR scanner UI: no camera permission in this app.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
    // The real org.json, for tests of code that reads and writes JSON: android.jar only has stubs.
    testImplementation("org.json:json:20240303")
}

// The sherpa-onnx library is 50 MB, so it is fetched, not kept in git: pinned by sha256, and a
// download that does not match is refused.
val sherpaAar = file("libs/sherpa-onnx-1.13.8.aar")
val sherpaSha = "633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96"
fun sha256Of(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }
val fetchSherpa by tasks.registering {
    outputs.file(sherpaAar)
    doLast {
        if (sherpaAar.isFile && sha256Of(sherpaAar) == sherpaSha) return@doLast
        sherpaAar.parentFile.mkdirs()
        val tmp = File(sherpaAar.path + ".part")
        URI("https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar").toURL().openStream().use { i -> tmp.outputStream().use { i.copyTo(it) } }
        val got = sha256Of(tmp)
        if (got != sherpaSha) { tmp.delete(); throw GradleException("sherpa-onnx-1.13.8.aar has sha256 $got, pinned $sherpaSha") }
        tmp.renameTo(sherpaAar)
    }
}
tasks.named("preBuild") { dependsOn(fetchSherpa) }
