import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PagerMessage } from "@/pager/types";

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
  cacheMessages,
  cacheRicUnits,
} = await import("@/pager/database");

test("optional storage opens lazily and can retry after an opening failure", () => {
  expect(opens).toBe(0);
  expect(initializeDatabase).toThrow("Cache unavailable");
  failOpen = false;
  initializeDatabase();
});

test("offline snapshots require the same approved identity and retain location updates", () => {
  const message: PagerMessage = {
    id: "native-message-id",
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "GORI V ŠOLI GOLO",
    duplicateOf: null,
  };
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
