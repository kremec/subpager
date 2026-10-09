// Expo applies these optimizations only to production bundles.
process.env.EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH = "1";
process.env.EXPO_UNSTABLE_TREE_SHAKING = "1";

const { getDefaultConfig } = require("expo/metro-config");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);

module.exports = config;
