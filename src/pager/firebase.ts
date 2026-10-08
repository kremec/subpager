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
  getDocFromServer,
  getDocsFromServer,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  type QueryConstraint,
} from "firebase/firestore";

import type { MessagePage, PagerMessage } from "@/pager/types";

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

export async function getMessagePage(before?: number): Promise<MessagePage> {
  const { database } = getFirebase();
  const constraints: QueryConstraint[] = [orderBy("id", "desc"), limit(50)];
  if (before !== undefined) constraints.push(startAfter(before));
  const snapshot = await getDocsFromServer(
    query(collection(database, "messages"), ...constraints),
  );
  const messages = snapshot.docs.map((item) => item.data() as PagerMessage);
  return {
    messages,
    nextCursor: messages.length === 50 ? messages.at(-1)!.id : null,
  };
}

export async function getMessage(id: number): Promise<PagerMessage> {
  const snapshot = await getDocFromServer(
    doc(getFirebase().database, "messages", String(id)),
  );
  if (!snapshot.exists()) throw new Error("Message not found.");
  return snapshot.data() as PagerMessage;
}

export function normalizeRics(rics: number[]) {
  if (rics.length > 100) throw new Error("Use at most 100 alert RICs.");
  if (rics.some((ric) => !Number.isInteger(ric) || ric < 0 || ric > 2097151))
    throw new Error("RICs must be whole numbers from 0 to 2097151.");
  return [...new Set(rics)];
}

export async function registerDevice(
  uid: string,
  expoPushToken: string | null,
  rics: number[],
) {
  await setDoc(doc(getFirebase().database, "devices", uid), {
    expoPushToken,
    rics,
  });
}
