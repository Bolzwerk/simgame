#!/usr/bin/env bash
# Baut die APK ohne Android-SDK/Gradle, nur mit den Debian/Ubuntu-Paketen
#   aapt dalvik-exchange apksigner zipalign
# und einer android.jar (z. B. Robolectric android-all) als ANDROID_JAR.
# Der reguläre Weg ist Gradle (siehe README); dieses Skript ist für Umgebungen ohne SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_JAR:?ANDROID_JAR muss auf eine android.jar zeigen}"
VERSION_NAME="${VERSION_NAME:-0.1.0}"
VERSION_CODE="${VERSION_CODE:-1}"
OUT="${OUT:-build/PixelPolis.apk}"

npm run build >/dev/null
APP=android/app
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sed 's|<manifest xmlns:android="http://schemas.android.com/apk/res/android">|<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="de.bolzwerk.pixelpolis">|' \
  "$APP/src/main/AndroidManifest.xml" > "$TMP/AndroidManifest.xml"

mkdir -p "$TMP/classes" "$TMP/gen"
aapt package -f -m -J "$TMP/gen" -M "$TMP/AndroidManifest.xml" -S "$APP/src/main/res" -A "$APP/src/main/assets" \
  -I "$ANDROID_JAR" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" -F "$TMP/unsigned.apk"
javac -nowarn --release 8 -cp "$ANDROID_JAR" -d "$TMP/classes" \
  $(find "$APP/src/main/java" "$TMP/gen" -name '*.java') 2>&1 | grep -v "^warning\|^Note" || true
DX=$(command -v dx || command -v dalvik-exchange)
"$DX" --dex --min-sdk-version=24 --output="$TMP/classes.dex" "$TMP/classes"
(cd "$TMP" && zip -q unsigned.apk classes.dex)
zipalign -f 4 "$TMP/unsigned.apk" "$TMP/aligned.apk"
mkdir -p "$(dirname "$OUT")"
apksigner sign --ks "$APP/pixelpolis.keystore" --ks-pass pass:pixelpolis --key-pass pass:pixelpolis \
  --ks-key-alias pixelpolis --out "$OUT" "$TMP/aligned.apk"
apksigner verify --print-certs "$OUT" | head -2
echo "APK: $OUT"
