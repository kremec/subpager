import type AsyncStorage from "@react-native-async-storage/async-storage";
import type { Persistence } from "firebase/auth";

// Firebase's shared declarations omit this export from its React Native build.
declare module "firebase/auth" {
  export function getReactNativePersistence(
    storage: typeof AsyncStorage,
  ): Persistence;
}
