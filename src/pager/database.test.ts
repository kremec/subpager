import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PagerMessage } from "@/pager/types";

const message: PagerMessage = {
  id: "native-message-id",
  receivedAt: "2026-10-08T10:00:00Z",
  ric: 123,
  function: 0,
  type: "alpha",
  content: "GORI V ŠOLI GOLO",
  duplicateOf: null,
};
const directory = mkdtempSync(join(tmpdir(), "subpager-cache-test-"));
const databasePath = join(directory, "subpager-cache.db");
let sqlite: Database | undefined;
afterAll(() => {
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});
let opens = 0;
let failOpen = true;
mock.module("expo-sqlite", () => ({
  openDatabaseSync: () => {
    opens++;
    if (failOpen) throw new Error("Cache unavailable");
    const opened = new Database(databasePath);
    sqlite = opened;
    return {
      closeSync: () => opened.close(),
      execSync: (sql: string) => opened.exec(sql),
      withTransactionSync: (task: () => void) => opened.transaction(task)(),
      runSync: (sql: string, ...params: SQLQueryBindings[]) =>
        opened.query(sql).run(...params),
      getFirstSync: <T>(sql: string, ...params: SQLQueryBindings[]) =>
        opened.query<T, SQLQueryBindings[]>(sql).get(...params),
      getAllSync: <T>(sql: string, ...params: SQLQueryBindings[]) =>
        opened.query<T, SQLQueryBindings[]>(sql).all(...params),
    };
  },
  deleteDatabaseSync: (name: string) => {
    expect(name).toBe("subpager-cache.db");
    rmSync(databasePath);
  },
}));

const {
  initializeDatabase,
  cachedApproval,
  cacheApproval,
  cachedHistory,
  cachedSync,
  cacheMessages,
  cacheRicUnits,
} = await import("@/pager/database");

test("optional storage opens lazily and can retry after an opening failure", () => {
  expect(opens).toBe(0);
  expect(initializeDatabase).toThrow("Cache unavailable");
  failOpen = false;
});

test("the old JSON cache migrates into columns without losing offline history", () => {
  const legacy = new Database(databasePath);
  legacy.exec(`CREATE TABLE history (
    slot INTEGER PRIMARY KEY,
    uid TEXT NOT NULL,
    messages TEXT NOT NULL,
    units TEXT NOT NULL
  )`);
  legacy
    .query("INSERT INTO history VALUES (1, ?, ?, ?)")
    .run(
      "legacy-device",
      JSON.stringify([message]),
      JSON.stringify([{ ric: 123, unitName: "Golo" }]),
    );
  legacy.close();

  initializeDatabase();
  expect(cachedApproval("legacy-device")).toBe(true);
  expect(cachedHistory("legacy-device")).toEqual({
    messages: [{ ...message, location: null }],
    units: [{ ric: 123, unitName: "Golo" }],
  });
  expect(sqlite!.query("SELECT content, ric FROM messages").get()).toEqual({
    content: message.content,
    ric: 123,
  });
  expect(
    sqlite!
      .query("SELECT name FROM sqlite_master WHERE name = 'history'")
      .get(),
  ).toBeNull();
});

test("offline snapshots require the same approved identity and retain location updates", () => {
  cacheApproval("approved-device", true);
  cacheMessages("approved-device", [message]);
  cacheRicUnits("approved-device", [{ ric: 123, unitName: "Golo" }]);
  expect(cachedApproval("approved-device")).toBe(true);
  expect(cachedApproval("another-device")).toBe(false);
  expect(cachedHistory("another-device")).toBeNull();
  cacheMessages("approved-device", [{ ...message, location: "ŠOLI GOLO" }]);
  cacheApproval("approved-device", true);
  expect(cachedHistory("approved-device")).toEqual({
    messages: [{ ...message, location: "ŠOLI GOLO" }],
    units: [{ ric: 123, unitName: "Golo" }],
  });
});

test("snapshot replacement removes deleted rows and reads messages newest first", () => {
  const newer: PagerMessage = {
    ...message,
    id: "newer-message",
    receivedAt: "2026-10-08T11:00:00Z",
    duplicateOf: message.id,
    location: "Golo",
  };
  cacheMessages("approved-device", [message, newer]);
  cacheRicUnits("approved-device", [
    { ric: 123, unitName: "Golo" },
    { ric: 456, unitName: "Other unit" },
  ]);
  expect(cachedHistory("approved-device")?.messages).toEqual([
    newer,
    { ...message, location: null },
  ]);
  cacheMessages("approved-device", [newer]);
  cacheRicUnits("approved-device", []);
  expect(cachedHistory("approved-device")).toEqual({
    messages: [newer],
    units: [],
  });
});

test("failed snapshot writes roll back without deleting saved data", () => {
  const saved = cachedHistory("approved-device");
  expect(() => cacheMessages("approved-device", [message, message])).toThrow();
  expect(cachedHistory("approved-device")).toEqual(saved);
  expect(() =>
    cacheRicUnits("approved-device", [
      { ric: 123, unitName: "Golo" },
      { ric: 123, unitName: "Duplicate" },
    ]),
  ).toThrow();
  expect(cachedHistory("approved-device")).toEqual(saved);
});

test("incremental sync preserves history and saves exact cursor together with late updates", () => {
  const cursor = { seconds: 123, nanoseconds: 456 };
  cacheMessages("approved-device", [message], {
    messages: [message],
    removedIds: [],
    cursor,
    reset: true,
  });
  const newer = { ...message, id: "newer", receivedAt: "2026-10-09T12:00:00Z" };
  cacheMessages("approved-device", [newer], {
    messages: [newer],
    removedIds: [],
    cursor,
    reset: false,
  });
  const update = { ...message, location: "Late location" };
  const nextCursor = { seconds: 123, nanoseconds: 457 };
  cacheMessages("approved-device", [update], {
    messages: [update],
    removedIds: [],
    cursor: nextCursor,
    reset: false,
  });
  expect(cachedHistory("approved-device")?.messages).toEqual([
    { ...newer, location: null },
    update,
  ]);
  expect(cachedSync("approved-device")).toEqual({
    initialized: true,
    cursor: nextCursor,
    ricRevision: null,
  });
});

test("a failed message batch rolls back both records and cursor", () => {
  const history = cachedHistory("approved-device");
  const sync = cachedSync("approved-device");
  const changes = {
    messages: [
      { ...message, location: "Uncommitted" },
      { ...message, id: "invalid", ric: Number.NaN },
    ],
    removedIds: [],
    cursor: { seconds: 999, nanoseconds: 999 },
    reset: false,
  };
  expect(() =>
    cacheMessages("approved-device", changes.messages, changes),
  ).toThrow();
  expect(cachedHistory("approved-device")).toEqual(history);
  expect(cachedSync("approved-device")).toEqual(sync);
});

test("catalog revision is committed with its rows and empty bootstrap is initialized", () => {
  cacheRicUnits("approved-device", [{ ric: 123, unitName: "Golo" }], "r1");
  expect(cachedSync("approved-device").ricRevision).toBe("r1");
  expect(() =>
    cacheRicUnits(
      "approved-device",
      [
        { ric: 123, unitName: "Golo" },
        { ric: 123, unitName: "Duplicate" },
      ],
      "r2",
    ),
  ).toThrow();
  expect(cachedSync("approved-device").ricRevision).toBe("r1");
  cacheMessages("approved-device", [], {
    messages: [],
    removedIds: [],
    cursor: { seconds: 0, nanoseconds: 0 },
    reset: true,
  });
  expect(cachedSync("approved-device").initialized).toBe(true);
  expect(cachedHistory("approved-device")?.messages).toEqual([]);
});

test("identity changes isolate snapshots and revocation removes approval and all data", () => {
  cacheApproval("new-device", true);
  cacheMessages("approved-device", []);
  cacheRicUnits("approved-device", [{ ric: 123, unitName: "Stale unit" }]);
  cacheApproval("approved-device", false);
  expect(cachedHistory("approved-device")).toBeNull();
  expect(cachedApproval("new-device")).toBe(true);
  expect(cachedHistory("new-device")).toEqual({ messages: [], units: [] });
  cacheApproval("new-device", false);
  expect(cachedApproval("new-device")).toBe(false);
  expect(cachedHistory("new-device")).toBeNull();
});

test("failed SQL revocation deletes the cache file without clearing another identity", () => {
  cacheApproval("revoked-device", true);
  cacheRicUnits("revoked-device", [{ ric: 123, unitName: "Golo" }]);
  sqlite!.exec("PRAGMA query_only = ON");
  cacheApproval("other-device", false);
  expect(cachedApproval("revoked-device")).toBe(true);
  expect(existsSync(databasePath)).toBe(true);
  cacheApproval("revoked-device", false);
  expect(existsSync(databasePath)).toBe(false);
  expect(cachedApproval("revoked-device")).toBe(false);
  expect(cachedHistory("revoked-device")).toBeNull();
  cacheApproval("new-device", true);
  expect(cachedApproval("new-device")).toBe(true);
});
