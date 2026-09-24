// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "web-dist/*", "android/*", "ios/*"],
  },
  {
    // the Worker runtime's built-in modules
    files: ["cloud/**"],
    rules: { "import/no-unresolved": ["error", { ignore: ["^cloudflare:"] }] },
  },
]);
