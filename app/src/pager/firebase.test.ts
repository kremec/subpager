import { beforeEach, expect, mock, test } from "bun:test";

import type {
  CachedSync,
  MessageChanges,
  PagerMessage,
  RicUnit,
  SyncTimestamp,
} from "@/pager/types";

interface Document {
  id: string;
  data: () => PagerMessage & { updatedAt?: SyncTimestamp };
}
interface Change {
  type: "added" | "modified" | "removed";
  doc: Document;
}
interface Snapshot {
  metadata: { fromCache: boolean };
  docs: Document[];
  docChanges: () => Change[];
  data: () => { revision: string };
}
let snapshotListener: ((snapshot: Snapshot) => void) | undefined;
const received: MessageChanges[] = [];
const orders: [string, string | undefined][] = [];
const filters: [string, string, SyncTimestamp][] = [];
const writes: { path: string; token: string | null }[] = [];
const paths: string[] = [];
let catalogReads = 0;
let catalog: { revision: string; units: RicUnit[] } = {
  revision: "r1",
  units: [{ ric: 123, unitName: "Golo" }],
};
let catalogLookup: (() => Promise<void>) | undefined;
const initial: CachedSync = {
  initialized: false,
  cursor: { seconds: 0, nanoseconds: 0 },
  ricRevision: null,
};
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
  orderBy: (field: string, direction?: string) => {
    orders.push([field, direction]);
    return {};
  },
  where: (field: string, comparison: string, value: SyncTimestamp) => {
    filters.push([field, comparison, value]);
    return {};
  },
  Timestamp: class {
    constructor(
      public seconds: number,
      public nanoseconds: number,
    ) {}
  },
  query: (name: string) => name,
  onSnapshot: (
    path: string,
    options: { includeMetadataChanges: boolean },
    listener: typeof snapshotListener,
  ) => {
    expect(options.includeMetadataChanges).toBe(true);
    paths.push(path);
    snapshotListener = listener;
    return () => {};
  },
  doc: (_db: object, collection: string, uid: string) => `${collection}/${uid}`,
  getDocFromServer: async (path: string) => {
    expect(path).toBe("config/ricUnits");
    catalogReads++;
    const data = catalog;
    await catalogLookup?.();
    return { data: () => data };
  },
  setDoc: async (
    path: string,
    data: { expoPushToken: string | null },
    options: { merge: boolean },
  ) => {
    expect(Object.keys(data)).toEqual(["expoPushToken"]);
    expect(options).toEqual({ merge: true });
    writes.push({ path, token: data.expoPushToken });
  },
}));
const { registerDevice, watchMessages, watchRicUnits } =
  await import("@/pager/firebase");
function snapshot(
  messages: (PagerMessage & { updatedAt?: SyncTimestamp })[],
  fromCache = false,
  changes?: Change[],
) {
  const docs = messages.map((message) => ({
    id: message.id,
    data: () => message,
  }));
  snapshotListener?.({
    metadata: { fromCache },
    docs,
    docChanges: () => changes ?? docs.map((doc) => ({ type: "added", doc })),
    data: () => ({ revision: catalog.revision }),
  });
}
function accept(changes: MessageChanges) {
  received.push(changes);
  return true;
}
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  received.length = 0;
  orders.length = 0;
  filters.length = 0;
  writes.length = 0;
  paths.length = 0;
  catalogReads = 0;
  catalogLookup = undefined;
  catalog = { revision: "r1", units: [{ ric: 123, unitName: "Golo" }] };
});

test("bootstrap includes legacy messages and server metadata confirmation persists even an empty result", () => {
  watchMessages(initial, accept, () => {});
  snapshot([fixture], true);
  expect(received).toEqual([]);
  snapshot([fixture], false, []);
  expect(received).toEqual([
    {
      messages: [fixture],
      removedIds: [],
      cursor: initial.cursor,
      reset: true,
    },
  ]);
  expect(orders).toEqual([["receivedAt", "desc"]]);
  watchMessages(initial, accept, () => {});
  snapshot([]);
  expect(received.at(-1)?.reset).toBe(true);
});

test("resume uses an inclusive exact cursor and delivers incremental late location updates", () => {
  const stamp = { seconds: 123, nanoseconds: 456 };
  watchMessages(
    { ...initial, initialized: true, cursor: stamp },
    accept,
    () => {},
  );
  snapshot([{ ...fixture, updatedAt: stamp }]);
  const modified = {
    ...fixture,
    location: "Golo",
    updatedAt: { seconds: 123, nanoseconds: 457 },
  };
  const other = { ...fixture, id: "other-id", updatedAt: stamp };
  snapshot([modified, other], false, [
    { type: "modified", doc: { id: fixture.id, data: () => modified } },
  ]);
  expect(filters).toEqual([["updatedAt", ">=", stamp]]);
  expect(orders).toEqual([["updatedAt", undefined]]);
  expect(received.at(-1)).toEqual({
    messages: [{ ...fixture, location: "Golo" }],
    removedIds: [],
    cursor: modified.updatedAt,
    reset: false,
  });
  snapshot([modified, other], false, []);
  expect(received).toHaveLength(2);
});

test("cache failure replays the query snapshot before accepting a durable cursor", () => {
  let saved = false;
  watchMessages(
    initial,
    (changes) => {
      received.push(changes);
      return saved;
    },
    () => {},
  );
  snapshot([fixture]);
  saved = true;
  snapshot([fixture, { ...fixture, id: "newer" }], false, []);
  expect(received.at(-1)?.messages).toHaveLength(2);
  expect(received.at(-1)?.reset).toBe(true);
});

test("messages sharing the durable timestamp are retained at the inclusive boundary", () => {
  const cursor = { seconds: 123, nanoseconds: 456 };
  watchMessages({ ...initial, initialized: true, cursor }, accept, () => {});
  const first = { ...fixture, updatedAt: cursor };
  const second = { ...fixture, id: "same-commit", updatedAt: cursor };
  snapshot([first, second]);
  expect(received[0]?.messages.map((message) => message.id)).toEqual([
    fixture.id,
    second.id,
  ]);
  expect(received[0]?.cursor).toEqual(cursor);
});

test("server confirmation replays additions that first arrived in an ignored cache snapshot", () => {
  const saved = new Map<string, PagerMessage>();
  let durable = initial;
  const persist = (changes: MessageChanges) => {
    if (changes.reset) saved.clear();
    for (const id of changes.removedIds) saved.delete(id);
    for (const message of changes.messages) saved.set(message.id, message);
    durable = { ...durable, initialized: true, cursor: changes.cursor };
    return true;
  };
  const a = { ...fixture, updatedAt: { seconds: 1, nanoseconds: 0 } };
  const b = {
    ...fixture,
    id: "cached-addition",
    updatedAt: { seconds: 2, nanoseconds: 0 },
  };
  const c = {
    ...fixture,
    id: "later-addition",
    updatedAt: { seconds: 3, nanoseconds: 0 },
  };
  watchMessages(initial, persist, () => {});
  snapshot([a]);
  snapshot([a, b], true);
  snapshot([a, b], false, []);
  snapshot([a, b, c], false, [
    { type: "added", doc: { id: c.id, data: () => c } },
  ]);
  watchMessages(durable, persist, () => {});
  snapshot([c]);
  expect([...saved.keys()]).toEqual([a.id, b.id, c.id]);
  expect(durable.cursor).toEqual(c.updatedAt);
});

test("full confirmation detects removals from skipped cache snapshots and retries failed removals", () => {
  let saved = true;
  const cursor = { seconds: 1, nanoseconds: 0 };
  watchMessages(
    { ...initial, initialized: true, cursor },
    (changes) => {
      received.push(changes);
      return saved;
    },
    () => {},
  );
  snapshot([{ ...fixture, updatedAt: cursor }]);
  snapshot([], true);
  saved = false;
  snapshot([], false, []);
  expect(received.at(-1)?.removedIds).toEqual([fixture.id]);
  saved = true;
  const next = {
    ...fixture,
    id: "next-message",
    updatedAt: { seconds: 2, nanoseconds: 0 },
  };
  snapshot([next], false, [
    { type: "added", doc: { id: next.id, data: () => next } },
  ]);
  expect(received.at(-1)?.removedIds).toEqual([fixture.id]);
  expect(received.at(-1)?.reset).toBe(false);
  expect(received.at(-1)?.messages[0]?.id).toBe(next.id);
});

test("Firestore document identity wins over a legacy data id field", () => {
  watchMessages(initial, accept, () => {});
  snapshotListener?.({
    metadata: { fromCache: false },
    docs: [{ id: "document-id", data: () => fixture }],
    docChanges: () => [],
    data: () => ({ revision: "" }),
  });
  expect(received[0]?.messages[0]?.id).toBe("document-id");
});

test("unchanged RIC revision reads only the small revision document", async () => {
  const units: RicUnit[][] = [];
  watchRicUnits(
    () => "r1",
    (next) => units.push(next),
    () => {},
  );
  snapshot([]);
  await settle();
  expect(paths).toEqual(["config/ricUnitsRevision"]);
  expect(catalogReads).toBe(0);
  expect(units).toEqual([]);
});

test("changed RIC revision fetches one catalog and cleanup rejects a late response", async () => {
  let finish = () => {};
  catalogLookup = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const units: RicUnit[][] = [];
  const unsubscribe = watchRicUnits(
    () => null,
    (next) => units.push(next),
    () => {},
  );
  snapshot([]);
  expect(catalogReads).toBe(1);
  unsubscribe();
  finish();
  await settle();
  expect(units).toEqual([]);
});

test("outdated RIC fetch cannot replace a newer catalog", async () => {
  const finish: (() => void)[] = [];
  catalogLookup = () =>
    new Promise<void>((resolve) => {
      finish.push(resolve);
    });
  const revisions: string[] = [];
  watchRicUnits(
    () => null,
    (_next, revision) => revisions.push(revision),
    () => {},
  );
  snapshot([]);
  catalog = { revision: "r2", units: [] };
  snapshot([]);
  finish[1]?.();
  await settle();
  finish[0]?.();
  await settle();
  expect(revisions).toEqual(["r2"]);
});

test("user tokens are scoped to Firebase UID, preserve approval fields and can be explicitly cleared", async () => {
  await registerDevice("firebase-device", "ExpoPushToken[test]");
  await registerDevice("firebase-device", null);
  expect(writes).toEqual([
    { path: "users/firebase-device", token: "ExpoPushToken[test]" },
    { path: "users/firebase-device", token: null },
  ]);
});
