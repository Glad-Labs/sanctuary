// Expo config plugin: sign release builds with the Glad Labs keystore and
// build only for 64-bit ARM, the architecture of every phone that will run
// this. The keystore and its password live outside the repo in
// ~/.sanctuary (see README); without them, Gradle falls back to debug signing.
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

function withReleaseSigning(config) {
  config = withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter((p) => !(p.type === 'property' && p.key === 'reactNativeArchitectures'));
    c.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' });
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (!g.includes('sanctuaryRelease')) {
      g = g.replace(
        /signingConfigs \{\n(\s*)debug \{/,
        `signingConfigs {
$1// Release signing: keystore and passwords from the environment (release.sh).
$1sanctuaryRelease {
$1    def ks = System.getenv('SANCTUARY_KEYSTORE')
$1    if (ks != null && file(ks).exists()) {
$1        storeFile file(ks)
$1        storePassword System.getenv('SANCTUARY_STORE_PASSWORD')
$1        keyAlias 'sanctuary'
$1        keyPassword System.getenv('SANCTUARY_KEY_PASSWORD')
$1    }
$1}
$1debug {`,
      );
      g = g.replace(
        /release \{([\s\S]*?)signingConfig signingConfigs\.debug/,
        (m, inner) => `release {${inner}signingConfig((System.getenv('SANCTUARY_KEYSTORE') != null && file(System.getenv('SANCTUARY_KEYSTORE')).exists()) ? signingConfigs.sanctuaryRelease : signingConfigs.debug)`,
      );
    }
    c.modResults.contents = g;
    return c;
  });
  return config;
}
module.exports = withReleaseSigning;
