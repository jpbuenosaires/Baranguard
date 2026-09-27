// Uniwind (Tailwind v4 for RN) needs its own Metro transform to turn
// global.css into the runtime style tables HeroUI Native's components (and
// any screen using `className`) read from. `withUniwindConfig` must be the
// OUTERMOST wrapper — see https://docs.uniwind.dev/quickstart.
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
});
