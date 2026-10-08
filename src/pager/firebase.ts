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
    throw new Error(
      "Firebase is not configured in this build. Ask the administrator for a configured app.",
    );
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
  onMessages: (messages: PagerMessage[]) => void,
  onError: (error: Error) => void,
) {
  const { database } = getFirebase();
  let initialized = false;
  return onSnapshot(
    query(collection(database, "messages"), orderBy("id", "desc")),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.metadata.fromCache) {
        initialized = false;
        return;
      }
      const documents = initialized
        ? snapshot
            .docChanges()
            .filter((change) => change.type === "added")
            .map((change) => change.doc)
        : snapshot.docs;
      initialized = true;
      onMessages(documents.map((item) => item.data() as PagerMessage));
    },
    onError,
  );
}

export function watchRicUnits(
  onUnits: (units: RicUnit[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(getFirebase().database, "ricUnits"),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.metadata.fromCache) return;
      onUnits(snapshot.docs.map((item) => item.data() as RicUnit));
    },
    onError,
  );
}

export async function registerDevice(
  uid: string,
  expoPushToken: string | null,
) {
  await setDoc(doc(getFirebase().database, "devices", uid), {
    expoPushToken,
    rics: [],
  });
}
