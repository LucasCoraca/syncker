plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.syncker"
    compileSdk = 34
    ndkVersion = "29.0.14206865" // lets AGP strip the prebuilt native libraries

    defaultConfig {
        applicationId = "app.syncker"
        minSdk = 29
        targetSdk = 34
        versionCode = 4
        versionName = "1.2.1"
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = false
        }
    }

    buildTypes {
        release {
            // Compose is big; R8 drops what the app doesn't use.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Debug signing so the release APK installs without a keystore; replace for store builds.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // The app's screens are Jetpack Compose (versions as cached for offline builds).
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        jniLibs {
            // Compress native libs in the APK (bare-kit embeds V8: ~65 MB raw,
            // ~17 MB compressed); they are extracted once at install time.
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(files("libs/bare-kit.jar"))
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
