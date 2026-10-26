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
        versionCode = 2
        versionName = "1.1.0"
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
            isMinifyEnabled = false
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
}
