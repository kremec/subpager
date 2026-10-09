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
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";

import type {
  CachedSync,
  MessageChanges,
  PagerMessage,
  RicUnit,
  SyncTimestamp,
} from "@/pager/types";

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
  sync: CachedSync,
  success: (changes: MessageChanges) => boolean,
  failure: (error: Error) => void,
) {
  const { database } = getFirebase();
  let first = true;
  let cursor = sync.cursor;
  const confirmedIds = new Set<string>();
  return onSnapshot(
    sync.initialized
      ? query(
          collection(database, "messages"),
          where(
            "updatedAt",
            ">=",
            new Timestamp(cursor.seconds, cursor.nanoseconds),
          ),
          orderBy("updatedAt"),
        )
      : query(collection(database, "messages"), orderBy("receivedAt", "desc")),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (snapshot.metadata.fromCache) {
        // docChanges compares against cached snapshots too. Replay their confirmed result.
        first = true;
        return;
      }
      const changes = snapshot.docChanges();
      const documents = first
        ? snapshot.docs
        : changes
            .filter((change) => change.type !== "removed")
            .map((change) => change.doc);
      const messages = documents.map((item) => {
        const { updatedAt, ...message } = item.data() as Omit<
          PagerMessage,
          "id"
        > & {
          updatedAt?: SyncTimestamp;
        };
        if (
          updatedAt &&
          (updatedAt.seconds > cursor.seconds ||
            (updatedAt.seconds === cursor.seconds &&
              updatedAt.nanoseconds > cursor.nanoseconds))
        )
          cursor = {
            seconds: updatedAt.seconds,
            nanoseconds: updatedAt.nanoseconds,
          };
        return { ...message, id: item.id };
      });
      const presentIds = first
        ? new Set(documents.map((item) => item.id))
        : null;
      const removedIds = presentIds
        ? [...confirmedIds].filter((id) => !presentIds.has(id))
        : changes
            .filter((change) => change.type === "removed")
            .map((change) => change.doc.id);
      if (first || messages.length || removedIds.length) {
        if (
          !success({
            messages,
            removedIds,
            cursor,
            reset: first && !sync.initialized,
          })
        ) {
          first = true;
          return;
        }
        // Keep failed removals in this set so the next replay retries them.
        for (const id of removedIds) confirmedIds.delete(id);
        for (const message of messages) confirmedIds.add(message.id);
      }
      first = false;
    },
    failure,
  );
}

export function watchRicUnits(
  savedRevision: () => string | null,
  success: (units: RicUnit[], revision: string) => void,
  failure: (error: Error) => void,
) {
  const { database } = getFirebase();
  let cancelled = false;
  let request = 0;
  const unsubscribe = onSnapshot(
    doc(database, "config", "ricUnitsRevision"),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (cancelled || snapshot.metadata.fromCache) return;
      const currentRequest = ++request;
      const revision = snapshot.data()?.revision as string | undefined;
      if (!revision || revision === savedRevision()) return;
      void getDocFromServer(doc(database, "config", "ricUnits"))
        .then((catalog) => {
          if (cancelled || request !== currentRequest) return;
          const data = catalog.data() as
            | { revision: string; units: RicUnit[] }
            | undefined;
          if (data?.revision === revision) success(data.units, revision);
        })
        .catch((error: Error) => {
          if (!cancelled && request === currentRequest) failure(error);
        });
    },
    failure,
  );
  return () => {
    cancelled = true;
    unsubscribe();
  };
}

export async function registerDevice(
  uid: string,
  expoPushToken: string | null,
) {
  const { database } = getFirebase();
  // setDoc resolves after server acknowledgement, including when a write starts offline.
  await setDoc(doc(database, "users", uid), { expoPushToken }, { merge: true });
}
