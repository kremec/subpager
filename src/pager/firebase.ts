import Constants from "expo-constants";

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseOptions,
} from "firebase/app";
import {
  getAuth,
  getReactNativePersistence,
  initializeAuth,
} from "firebase/auth";
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";

import type { PagerMessage, RicUnit } from "@/pager/types";

export function getFirebase() {
  const config = Constants.expoConfig?.extra
    ?.firebase as FirebaseOptions | null;
  if (!config?.apiKey || !config.projectId || !config.appId)
    throw new Error("Firebase is not configured for this build.");
  const existing = getApps().length > 0;
  const app = existing ? getApp() : initializeApp(config);
  const auth = existing
    ? getAuth(app)
    : initializeAuth(app, {
        persistence: getReactNativePersistence(AsyncStorage),
      });
  return { auth, database: getFirestore(app) };
}

export function watchMessages(
  success: (messages: PagerMessage[]) => void,
  failure: (error: Error) => void,
) {
  const { database } = getFirebase();
  return onSnapshot(
    query(collection(database, "messages"), orderBy("receivedAt", "desc")),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.metadata.fromCache) return;
      success(
        snapshot.docs.map((item) => ({
          ...(item.data() as Omit<PagerMessage, "id">),
          id: item.id,
        })),
      );
    },
    failure,
  );
}

export function watchRicUnits(
  success: (units: RicUnit[]) => void,
  failure: (error: Error) => void,
) {
  const { database } = getFirebase();
  return onSnapshot(
    collection(database, "ricUnits"),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.metadata.fromCache) return;
      success(snapshot.docs.map((item) => item.data() as RicUnit));
    },
    failure,
  );
}

export async function registerDevice(
  uid: string,
  expoPushToken: string | null,
) {
  const { database } = getFirebase();
  // setDoc resolves after server acknowledgement, including when a write starts offline.
  await setDoc(doc(database, "devices", uid), { expoPushToken });
}
