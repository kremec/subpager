const IS_DEV = process.env.APP_VARIANT === "development";
const projectId = "0f53fe8f-bb64-4106-bb76-86ac5139e53e";

export default {
  name: IS_DEV ? "subpager (DEV)" : "subpager",
  slug: "subpager",
  version: "0.0.1",
  runtimeVersion: { policy: "fingerprint" },
  updates: { url: `https://u.expo.dev/${projectId}` },
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: IS_DEV ? "subpager-dev" : "subpager",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: IS_DEV
      ? "com.subbyte.subpager.dev"
      : "com.subbyte.subpager",
  },
  android: {
    package: IS_DEV ? "com.subbyte.subpager.dev" : "com.subbyte.subpager",
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-notifications",
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#F7F7F5",
        android: { image: "./assets/splash-icon.png", imageWidth: 76 },
      },
    ],
    ["expo-dev-client", { addGeneratedScheme: IS_DEV }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: { staging: IS_DEV, eas: { projectId } },
};
