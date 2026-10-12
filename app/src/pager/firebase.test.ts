import { beforeEach, expect, mock, test } from "bun:test";

import type {
  CachedSync,
  MessageChanges,
  PagerMessage,
  RicUnit,
  SpinEvent,
  SyncTimestamp,
} from "@/pager/types";

type MessageDocument = PagerMessage & {
  updatedAt?: SyncTimestamp;
  deleted?: boolean;
};
interface Document {
  id: string;
  data: () => MessageDocument | RicUnit;
}
interface Change {
  type: "added" | "modified" | "removed";
  doc: Document;
}
interface Snapshot {
  id: string;
  metadata: { fromCache: boolean };
  docs: Document[];
  docChanges: () => Change[];
  data: () => SpinEvent | undefined;
}
let snapshotListener: ((snapshot: Snapshot) => void) | undefined;
const received: MessageChanges[] = [];
const orders: [string, string | undefined][] = [];
const filters: [string, string, SyncTimestamp | number][] = [];
const writes: { path: string; token: string | null }[] = [];
const paths: string[] = [];
const initial: CachedSync = {
  initialized: false,
  cursor: { seconds: 0, nanoseconds: 0 },
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
  where: (field: string, comparison: string, value: SyncTimestamp | number) => {
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
const { registerDevice, watchMessages, watchRicUnits, watchSpinEvent } =
  await import("@/pager/firebase");
function snapshot(
  messages: MessageDocument[],
  fromCache = false,
  changes?: Change[],
) {
  const docs = messages.map((message) => ({
    id: message.id,
    data: () => message,
  }));
  snapshotListener?.({
    id: "snapshot-id",
    metadata: { fromCache },
    docs,
    docChanges: () => changes ?? docs.map((doc) => ({ type: "added", doc })),
    data: () => undefined,
  });
}
function accept(changes: MessageChanges) {
  received.push(changes);
  return true;
}
beforeEach(() => {
  received.length = 0;
  orders.length = 0;
  filters.length = 0;
  writes.length = 0;
  paths.length = 0;
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

test("an offline deletion removes an older cached pager and persists the deletion cursor", () => {
  const cursor = { seconds: 123, nanoseconds: 456 };
  watchMessages({ ...initial, initialized: true, cursor }, accept, () => {});
  const marker = {
    ...fixture,
    content: "",
    deleted: true,
    updatedAt: { seconds: 200, nanoseconds: 1 },
  };
  snapshot([marker], true);
  expect(received).toEqual([]);
  snapshot([marker], false, []);
  expect(received).toEqual([
    {
      messages: [],
      removedIds: [fixture.id],
      cursor: marker.updatedAt,
      reset: false,
    },
  ]);
});

test("live deletion and failed cache writes replay removals without showing markers", () => {
  let saved = true;
  watchMessages(
    initial,
    (changes) => {
      received.push(changes);
      return saved;
    },
    () => {},
  );
  snapshot([fixture]);
  const marker = {
    ...fixture,
    content: "",
    deleted: true,
    updatedAt: { seconds: 200, nanoseconds: 1 },
  };
  saved = false;
  snapshot([marker], false, [
    { type: "modified", doc: { id: marker.id, data: () => marker } },
  ]);
  expect(received.at(-1)?.removedIds).toEqual([fixture.id]);
  expect(received.at(-1)?.messages).toEqual([]);
  saved = true;
  snapshot([marker], false, []);
  expect(received.at(-1)?.removedIds).toEqual([fixture.id]);
  expect(received.at(-1)?.cursor).toEqual(marker.updatedAt);
  expect(received.at(-1)?.messages).toEqual([]);
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
    id: "document-id",
    metadata: { fromCache: false },
    docs: [{ id: "document-id", data: () => fixture }],
    docChanges: () => [],
    data: () => undefined,
  });
  expect(received[0]?.messages[0]?.id).toBe("document-id");
});

test("message snapshots carry provisional links and later confirmation", () => {
  watchMessages(initial, accept, () => {});
  const linked: PagerMessage = {
    ...fixture,
    spinEventId: "472584",
    spinMatchStatus: "provisional",
  };
  snapshot([linked]);
  expect(received[0]?.messages[0]).toEqual(linked);
  const confirmed: PagerMessage = {
    ...linked,
    spinMatchStatus: "confirmed",
  };
  snapshot([confirmed], false, [
    { type: "modified", doc: { id: confirmed.id, data: () => confirmed } },
  ]);
  expect(received.at(-1)?.messages[0]?.spinMatchStatus).toBe("confirmed");
});

test("RIC names query unit records without metadata and use only server-confirmed snapshots", () => {
  const units: RicUnit[][] = [];
  watchRicUnits(
    (next) => units.push(next),
    () => {},
  );
  expect(paths).toEqual(["ricUnits"]);
  expect(filters).toEqual([["ric", ">=", 0]]);
  const mappings = [{ ric: 123, unitName: "Golo" }];
  const next: Snapshot = {
    id: "ricUnits",
    metadata: { fromCache: true },
    docs: mappings.map((unit) => ({
      id: String(unit.ric),
      data: () => unit,
    })),
    docChanges: () => [],
    data: () => undefined,
  };
  snapshotListener?.(next);
  expect(units).toEqual([]);
  snapshotListener?.({ ...next, metadata: { fromCache: false } });
  expect(units).toEqual([mappings]);
  const revised = [{ ric: 123, unitName: "Updated Golo" }];
  snapshotListener?.({
    ...next,
    metadata: { fromCache: false },
    docs: revised.map((unit) => ({ id: String(unit.ric), data: () => unit })),
  });
  expect(units).toEqual([mappings, revised]);
});

test("an empty RIC server snapshot clears the mapping list", () => {
  const units: RicUnit[][] = [];
  watchRicUnits(
    (next) => units.push(next),
    () => {},
  );
  snapshot([]);
  expect(units).toEqual([[]]);
});

test("user tokens are scoped to Firebase UID, preserve approval fields and can be explicitly cleared", async () => {
  await registerDevice("firebase-device", "ExpoPushToken[test]");
  await registerDevice("firebase-device", null);
  expect(writes).toEqual([
    { path: "users/firebase-device", token: "ExpoPushToken[test]" },
    { path: "users/firebase-device", token: null },
  ]);
});

test("SPIN watches a linked document, ignores cached snapshots, and publishes server revisions and deletion", () => {
  const events: (SpinEvent | null)[] = [];
  watchSpinEvent(
    "472470",
    (event) => events.push(event),
    () => {},
  );
  expect(paths).toEqual(["spinEvents/472470"]);
  const event = {
    id: "legacy-id",
    title: "Požar",
    description: "Public report.",
    eventAt: "2026-10-09T12:27:37Z",
  };
  const next: Snapshot = {
    id: "472470",
    metadata: { fromCache: true },
    docs: [],
    docChanges: () => [],
    data: () => event,
  };
  snapshotListener?.(next);
  expect(events).toEqual([]);
  snapshotListener?.({ ...next, metadata: { fromCache: false } });
  expect(events).toEqual([{ ...event, id: "472470" }]);
  snapshotListener?.({
    ...next,
    metadata: { fromCache: false },
    data: () => ({ ...event, description: "Updated report." }),
  });
  expect(events.at(-1)?.description).toBe("Updated report.");
  snapshotListener?.({
    ...next,
    metadata: { fromCache: false },
    data: () => undefined,
  });
  expect(events.at(-1)).toBeNull();
});
