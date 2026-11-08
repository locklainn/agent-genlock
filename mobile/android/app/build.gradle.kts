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
    // Google's own QR scanner UI: no camera permission in this app.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
