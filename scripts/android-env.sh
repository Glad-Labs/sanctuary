# Source this before building the Android app: `source scripts/android-env.sh`
# JDK 17 and the Android SDK live under the home directory, installed without root.
export JAVA_HOME="$HOME/.jdks/temurin-17"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
