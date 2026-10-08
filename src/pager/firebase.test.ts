import { beforeEach, expect, mock, test } from "bun:test";

import type { PagerMessage } from "@/pager/types";

interface Snapshot {
  metadata: { fromCache: boolean };
  docs: { id: string; data: () => Omit<PagerMessage, "id"> }[];
}
let snapshotListener: ((snapshot: Snapshot) => void) | undefined;
const received: PagerMessage[][] = [];
const orders: [string, string][] = [];
const writes: { path: string; token: string | null }[] = [];
const fixture: PagerMessage = {
  id: "native-message-id",
  receivedAt: "2026-10-08T10:00:00Z",
  ric: 123,
  function: 0,
  type: "alpha",
  content: "GORI V ŠOLI GOLO",
  duplicateOf: null,
};

mock.module("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        firebase: {
          apiKey: "public-key",
          projectId: "test-project",
          appId: "test-app",
        },
      },
    },
  },
}));
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {},
}));
mock.module("firebase/app", () => ({
  getApps: () => [],
  getApp: () => ({}),
  initializeApp: () => ({}),
}));
mock.module("firebase/auth", () => ({
  getAuth: () => ({}),
  initializeAuth: () => ({}),
  getReactNativePersistence: () => ({}),
}));
mock.module("firebase/firestore", () => ({
  getFirestore: () => ({}),
  collection: (_db: object, name: string) => name,
  orderBy: (field: string, direction: string) => {
    orders.push([field, direction]);
    return {};
  },
  query: (name: string) => name,
  onSnapshot: (
    _query: string,
    options: { includeMetadataChanges: boolean },
    listener: typeof snapshotListener,
  ) => {
    expect(options.includeMetadataChanges).toBe(true);
    snapshotListener = listener;
    return () => {};
  },
  doc: (_db: object, collection: string, uid: string) => `${collection}/${uid}`,
  setDoc: async (path: string, data: { expoPushToken: string | null }) => {
    expect(Object.keys(data)).toEqual(["expoPushToken"]);
    writes.push({ path, token: data.expoPushToken });
  },
}));
const { registerDevice, watchMessages } = await import("@/pager/firebase");
function snapshot(messages: PagerMessage[], fromCache = false) {
  snapshotListener?.({
    metadata: { fromCache },
    docs: messages.map((message) => ({ id: message.id, data: () => message })),
  });
}
beforeEach(() => {
  received.length = 0;
  orders.length = 0;
  writes.length = 0;
});

test("confirmed full snapshots preserve native IDs and later locations and removals", () => {
  watchMessages(
    (messages) => received.push(messages),
    () => {},
  );
  snapshot([], true);
  snapshot([fixture], true);
  expect(received).toEqual([]);
  snapshot([fixture]);
  snapshot([{ ...fixture, location: "ŠOLI GOLO" }]);
  snapshot([]);
  expect(orders).toEqual([["receivedAt", "desc"]]);
  expect(received).toEqual([
    [fixture],
    [{ ...fixture, location: "ŠOLI GOLO" }],
    [],
  ]);
});

test("Firestore document identity wins over a legacy data id field", () => {
  watchMessages(
    (messages) => received.push(messages),
    () => {},
  );
  snapshotListener?.({
    metadata: { fromCache: false },
    docs: [{ id: "document-id", data: () => fixture }],
  });
  expect(received[0]?.[0]?.id).toBe("document-id");
});

test("device tokens are scoped to Firebase UID and can be explicitly cleared", async () => {
  await registerDevice("firebase-device", "ExpoPushToken[test]");
  await registerDevice("firebase-device", null);
  expect(writes).toEqual([
    { path: "devices/firebase-device", token: "ExpoPushToken[test]" },
    { path: "devices/firebase-device", token: null },
  ]);
});
