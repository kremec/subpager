import { expect, mock, test } from "bun:test";

import type { PagerMessage } from "@/pager/types";

interface MessageDocument {
  data: () => PagerMessage;
}

interface MessageChange {
  type: "added" | "modified" | "removed";
  doc: MessageDocument;
}

interface MessageSnapshot {
  metadata: { fromCache: boolean };
  docs: MessageDocument[];
  docChanges: () => MessageChange[];
}

let onMessagesSnapshot: ((snapshot: MessageSnapshot) => void) | undefined;

mock.module("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        firebase: { apiKey: "test", projectId: "test", appId: "test" },
      },
    },
  },
}));
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {},
}));
mock.module("firebase/app", () => ({
  getApp: () => ({}),
  getApps: () => [],
  initializeApp: () => ({}),
}));
mock.module("firebase/auth", () => ({
  getAuth: () => ({}),
  initializeAuth: () => ({}),
  getReactNativePersistence: () => ({}),
}));
mock.module("firebase/firestore", () => ({
  getFirestore: () => ({}),
  collection: () => ({}),
  doc: () => ({}),
  orderBy: () => ({}),
  query: () => ({}),
  setDoc: async () => {},
  onSnapshot: (
    _query: object,
    _options: object,
    listener: (snapshot: MessageSnapshot) => void,
  ) => {
    onMessagesSnapshot = listener;
    return () => {};
  },
}));

const { watchMessages } = await import("@/pager/firebase");

test("message listener reconciles confirmed history after cached snapshots and otherwise passes only additions", () => {
  const first: PagerMessage = {
    id: 1,
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "Original",
    duplicateOf: null,
  };
  const second = { ...first, id: 2, content: "New" };
  const batches: PagerMessage[][] = [];
  watchMessages(
    (messages) => batches.push(messages),
    () => {},
  );

  onMessagesSnapshot?.({
    metadata: { fromCache: true },
    docs: [{ data: () => first }],
    docChanges: () => [],
  });
  expect(batches).toEqual([]);

  // The server may confirm cached documents with only a metadata change.
  onMessagesSnapshot?.({
    metadata: { fromCache: false },
    docs: [{ data: () => first }],
    docChanges: () => [],
  });
  expect(batches).toEqual([[first]]);

  onMessagesSnapshot?.({
    metadata: { fromCache: false },
    docs: [{ data: () => first }, { data: () => second }],
    docChanges: () => [
      { type: "modified", doc: { data: () => first } },
      { type: "removed", doc: { data: () => first } },
      { type: "added", doc: { data: () => second } },
    ],
  });
  expect(batches).toEqual([[first], [second]]);

  const third = { ...first, id: 3, content: "Cached before confirmation" };
  onMessagesSnapshot?.({
    metadata: { fromCache: true },
    docs: [{ data: () => third }],
    docChanges: () => [{ type: "added", doc: { data: () => third } }],
  });
  expect(batches).toEqual([[first], [second]]);
  onMessagesSnapshot?.({
    metadata: { fromCache: false },
    docs: [
      { data: () => first },
      { data: () => second },
      { data: () => third },
    ],
    // Query sync-state changes can confirm data without any document changes.
    docChanges: () => [],
  });
  expect(batches).toEqual([[first], [second], [first, second, third]]);
});
