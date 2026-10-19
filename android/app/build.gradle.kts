plugins {
    id("com.android.application")
}

android {
    namespace = "de.bolzwerk.pixelpolis"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.bolzwerk.pixelpolis"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1.0"
    }

    signingConfigs {
        // Fester Schlüssel im Repository, damit Updates ohne Neuinstallation (und ohne Verlust der Spielstände) gehen.
        create("shared") {
            storeFile = file("pixelpolis.keystore")
            storePassword = "pixelpolis"
            keyAlias = "pixelpolis"
            keyPassword = "pixelpolis"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Das Spiel selbst liegt als gebündeltes Web-Spiel in assets/www (npm run build).
tasks.named("preBuild") {
    doFirst {
        if (!file("src/main/assets/www/game.js").exists()) {
            throw GradleException("assets/www fehlt: zuerst im Hauptordner 'npm ci && npm run build' ausführen.")
        }
    }
}
