#!/usr/bin/env bash
# Builds the Android APKs: embeds the UI, writes the app icons, bundles the worklet with bare-pack,
# links native addons with bare-link, then runs Gradle.
#   ANDROID_HOME (or android/local.properties) must point at an SDK with NDK 29.
#   JAVA_HOME must be a JDK 17.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/embed-ui.js
node scripts/icons-kt.js
node node_modules/bare-pack/bin.js --preset android --linked --out android/app/src/main/assets/syncker.bundle android/worklet.js
node node_modules/bare-link/bin.js --preset android --out android/app/src/main/jniLibs android/worklet.js

# bare-kit runtime: the prebuilt Android library shipped in react-native-bare-kit.
# Fetched once with `npm pack` (installing it would pull in React Native as a peer).
BARE_KIT_VERSION=0.16.0
CACHE=android/.bare-kit/$BARE_KIT_VERSION
if [ ! -f "$CACHE/package/android/libs/bare-kit/classes.jar" ]; then
  mkdir -p "$CACHE"
  (cd "$CACHE" && npm pack "react-native-bare-kit@$BARE_KIT_VERSION" --silent >/dev/null && tar xzf react-native-bare-kit-*.tgz package/android/libs && rm react-native-bare-kit-*.tgz)
fi
KIT=$CACHE/package/android/libs/bare-kit
mkdir -p android/app/libs
cp "$KIT/classes.jar" android/app/libs/bare-kit.jar
SDK=${ANDROID_HOME:-$(sed -n 's/^sdk.dir=//p' android/local.properties 2>/dev/null)}
SYSROOT=$(ls -d "$SDK"/ndk/*/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib | tail -1)
for pair in arm64-v8a:aarch64-linux-android armeabi-v7a:arm-linux-androideabi x86:i686-linux-android x86_64:x86_64-linux-android; do
  abi=${pair%%:*}
  mkdir -p "android/app/src/main/jniLibs/$abi"
  cp "$KIT/jni/$abi/libbare-kit.so" "android/app/src/main/jniLibs/$abi/"
  cp "$SYSROOT/${pair##*:}/libc++_shared.so" "android/app/src/main/jniLibs/$abi/"
done

cd android
./gradlew --offline "${1:-assembleDebug}"
