Sideload upload keystore (JKS).

Default passwords live in app/build.gradle.kts so every GitHub Actions
APK is signed with the SAME key and installs over the previous one.

To use your own key instead, set repository secrets:
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
