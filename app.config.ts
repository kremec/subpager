import { existsSync, readFileSync } from "node:fs";

const IS_DEV = process.env.APP_VARIANT === "development";
const projectId = "0f53fe8f-bb64-4106-bb76-86ac5139e53e";
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";
interface GoogleServices {
  project_info: { project_id: string; project_number: string };
  client: {
    client_info: {
      mobilesdk_app_id: string;
      android_client_info: { package_name: string };
    };
    api_key: { current_key: string }[];
  }[];
}
const googleServices = existsSync(googleServicesFile)
  ? (JSON.parse(readFileSync(googleServicesFile, "utf8")) as GoogleServices)
  : null;
const androidPackage = IS_DEV
  ? "com.subbyte.subpager.dev"
  : "com.subbyte.subpager";
const firebaseClient = googleServices?.client.find(
  (client) =>
    client.client_info.android_client_info.package_name === androidPackage,
);
// These are public client identifiers, never a service-account credential.
const firebase =
  firebaseClient && googleServices
    ? {
        apiKey: firebaseClient.api_key[0]?.current_key,
        projectId: googleServices.project_info.project_id,
        appId: firebaseClient.client_info.mobilesdk_app_id,
        messagingSenderId: googleServices.project_info.project_number,
      }
    : null;

export default {
  name: IS_DEV ? "subpager (DEV)" : "subpager",
  slug: "subpager",
  version: "0.0.2",
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
    package: androidPackage,
    googleServicesFile,
    predictiveBackGestureEnabled: false,
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ],
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
  extra: { staging: IS_DEV, eas: { projectId }, firebase },
};
