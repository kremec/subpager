import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PagerMessage } from "@/pager/types";

const message: PagerMessage = {
  id: "native-message-id",
  receptions: [{ ric: 123, time: "2026-10-08T10:00:00Z" }],
  function: 0,
  type: "alpha",
  content: "GORI V ŠOLI GOLO",
  spinEventId: null,
  spinMatchStatus: null,
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
  cachedSpinEvents,
  cacheSpinEvent,
} = await import("@/pager/database");

test("optional storage opens lazily and can retry after an opening failure", () => {
  expect(opens).toBe(0);
  expect(initializeDatabase).toThrow("Cache unavailable");
  failOpen = false;
});

test.each([
  { name: "pre-SPIN cache", spinColumns: false, version: 0 },
  { name: "already upgraded SPIN cache", spinColumns: true, version: 0 },
  { name: "cache from the first repair", spinColumns: true, version: 1 },
  {
    name: "cache retained across an OTA rollback",
    spinColumns: true,
    version: 2,
  },
  { name: "repaired cache on a later launch", spinColumns: true, version: 3 },
  { name: "grouped cache", spinColumns: true, version: 4 },
  { name: "reception cache on a later launch", spinColumns: true, version: 5 },
])(
  "$name preserves history and refreshes links only when needed",
  (fixture) => {
    const existing = new Database(databasePath);
    existing.exec(`
    CREATE TABLE approval (uid TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      ${
        fixture.version === 5
          ? "receptions TEXT NOT NULL"
          : `receivedAt TEXT NOT NULL, ${fixture.version === 4 ? "rics TEXT NOT NULL" : "ric INTEGER NOT NULL"}`
      }, function INTEGER NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, duplicateOf TEXT, location TEXT
      ${fixture.spinColumns ? ", spinEventId TEXT, spinMatchStatus TEXT" : ""}
    );
    CREATE TABLE sync_state (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), initialized INTEGER NOT NULL DEFAULT 0,
      seconds INTEGER NOT NULL DEFAULT 0, nanoseconds INTEGER NOT NULL DEFAULT 0,
      ricRevision TEXT
    );
    INSERT INTO approval VALUES ('existing-device');
    INSERT INTO sync_state VALUES (1, 1, 123, 456, 'r1');
    PRAGMA user_version = ${fixture.version};
  `);
    existing
      .query(
        `INSERT INTO messages (id, ${
          fixture.version === 5
            ? "receptions"
            : `receivedAt, ${fixture.version === 4 ? "rics" : "ric"}`
        }, function, type, content, duplicateOf, location) VALUES (?, ${fixture.version === 5 ? "?" : "?, ?"}, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        ...(fixture.version === 5
          ? [JSON.stringify(message.receptions)]
          : [
              message.receptions[0]!.time,
              fixture.version === 4
                ? JSON.stringify([message.receptions[0]!.ric, 456])
                : message.receptions[0]!.ric,
            ]),
        message.function,
        message.type,
        message.content,
        "original-message-id",
        null,
      );
    if (fixture.spinColumns) {
      existing
        .query(
          "UPDATE messages SET spinEventId = ?, spinMatchStatus = ? WHERE id = ?",
        )
        .run("472470", "confirmed", message.id);
    }
    // The rolled-back bundle cached these deletion markers as ordinary rows.
    const staleMessages: PagerMessage[] =
      fixture.version === 2
        ? ["repeat", "sf", "hash", "tone"].map((id, index) => ({
            ...message,
            id,
            type: id === "tone" ? "tone" : "alpha",
            content: [message.content, "SF", " #", ""][index]!,
          }))
        : [];
    for (const stale of staleMessages) {
      existing
        .query(
          "INSERT INTO messages (id, receivedAt, ric, function, type, content) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          stale.id,
          stale.receptions[0]!.time,
          stale.receptions[0]!.ric,
          stale.function,
          stale.type,
          stale.content,
        );
    }
    existing.close();

    initializeDatabase();
    expect(cachedHistory("existing-device")?.messages).toEqual(
      [message, ...staleMessages]
        .map((row) => ({
          ...row,
          location: null,
          spinEventId:
            fixture.spinColumns && row.id === message.id ? "472470" : null,
          spinMatchStatus:
            fixture.spinColumns && row.id === message.id
              ? ("confirmed" as const)
              : null,
        }))
        .sort((a, b) => b.id.localeCompare(a.id)),
    );
    expect(cachedSync("existing-device")).toEqual({
      initialized: fixture.version === 5,
      cursor:
        fixture.version === 5
          ? { seconds: 123, nanoseconds: 456 }
          : { seconds: 0, nanoseconds: 0 },
    });
    expect(sqlite!.query("PRAGMA user_version").get()).toEqual({
      user_version: 5,
    });
    const columns = sqlite!
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("receptions");
    for (const obsolete of ["ric", "rics", "receivedAt"])
      expect(columns).not.toContain(obsolete);
    const linked = {
      ...message,
      spinEventId: "472470",
      spinMatchStatus: "confirmed" as const,
    };
    const cursor = { seconds: 500, nanoseconds: 1 };
    cacheMessages("existing-device", [linked], {
      messages: [linked],
      removedIds: [],
      cursor,
      reset: !cachedSync("existing-device").initialized,
    });
    expect(cachedHistory("existing-device")?.messages[0]?.spinEventId).toBe(
      linked.spinEventId,
    );
    expect(
      cachedHistory("existing-device")?.messages.map((row) => row.id),
    ).toEqual([message.id]);
    expect(cachedSync("existing-device")).toEqual({
      initialized: true,
      cursor,
    });

    sqlite!.exec("PRAGMA query_only = ON");
    cacheApproval("existing-device", false);
  },
);

test("the old JSON cache migrates into columns without losing offline history", () => {
  const legacy = new Database(databasePath);
  legacy.exec(`CREATE TABLE history (
    slot INTEGER PRIMARY KEY,
    uid TEXT NOT NULL,
    messages TEXT NOT NULL,
    units TEXT NOT NULL
  )`);
  legacy.query("INSERT INTO history VALUES (1, ?, ?, ?)").run(
    "legacy-device",
    JSON.stringify([
      {
        ...message,
        receptions: undefined,
        receivedAt: message.receptions[0]!.time,
        ric: message.receptions[0]!.ric,
        duplicateOf: "original-message-id",
      },
    ]),
    JSON.stringify([{ ric: 123, unitName: "Golo" }]),
  );
  legacy.close();

  initializeDatabase();
  expect(cachedApproval("legacy-device")).toBe(true);
  expect(cachedHistory("legacy-device")).toEqual({
    messages: [{ ...message, location: null }],
    units: [{ ric: 123, unitName: "Golo" }],
  });
  expect(
    sqlite!.query("SELECT content, receptions FROM messages").get(),
  ).toEqual({
    content: message.content,
    receptions: JSON.stringify(message.receptions),
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

test("snapshot replacement orders events by their latest reception and removes deleted rows", () => {
  const newer: PagerMessage = {
    ...message,
    id: "newer-message",
    receptions: [
      { ric: 123, time: "2026-10-08T11:00:00Z" },
      { ric: 456, time: "2026-10-08T11:00:02Z" },
      { ric: 123, time: "2026-10-08T11:00:04Z" },
    ],
    location: "Golo",
  };
  const repeated: PagerMessage = {
    ...message,
    receptions: [
      ...message.receptions,
      { ric: 123, time: "2026-10-08T12:00:00Z" },
    ],
  };
  cacheMessages("approved-device", [repeated, newer]);
  cacheRicUnits("approved-device", [
    { ric: 123, unitName: "Golo" },
    { ric: 456, unitName: "Other unit" },
  ]);
  expect(cachedHistory("approved-device")?.messages).toEqual([
    { ...repeated, location: null },
    newer,
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
  const newer = {
    ...message,
    id: "newer",
    receptions: [{ ric: 123, time: "2026-10-09T12:00:00Z" }],
  };
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
  });
});

test("a failed message batch rolls back both records and cursor", () => {
  const history = cachedHistory("approved-device");
  const sync = cachedSync("approved-device");
  const changes = {
    messages: [
      { ...message, location: "Uncommitted" },
      { ...message, id: "invalid", function: Number.NaN },
    ],
    removedIds: ["newer"],
    cursor: { seconds: 999, nanoseconds: 999 },
    reset: false,
  };
  expect(() =>
    cacheMessages("approved-device", changes.messages, changes),
  ).toThrow();
  expect(cachedHistory("approved-device")).toEqual(history);
  expect(cachedSync("approved-device")).toEqual(sync);
});

test("a deletion-only batch removes cached rows and commits its cursor without clearing other history", () => {
  const cursor = { seconds: 124, nanoseconds: 0 };
  cacheMessages("approved-device", [], {
    messages: [],
    removedIds: ["newer"],
    cursor,
    reset: false,
  });
  const reopened = new Database(databasePath, { readonly: true });
  try {
    expect(reopened.query("SELECT id FROM messages").all()).toEqual([
      { id: message.id },
    ]);
    expect(
      reopened
        .query("SELECT seconds, nanoseconds FROM sync_state WHERE slot = 1")
        .get(),
    ).toEqual(cursor);
  } finally {
    reopened.close();
  }
  expect(cachedApproval("approved-device")).toBe(true);
});

test("late provisional SPIN references are committed with the cursor and survive reopening", () => {
  const update: PagerMessage = {
    ...message,
    spinEventId: "472470",
    spinMatchStatus: "provisional",
  };
  const cursor = { seconds: 124, nanoseconds: 1 };
  cacheMessages("approved-device", [update], {
    messages: [update],
    removedIds: [],
    cursor,
    reset: false,
  });
  const reopened = new Database(databasePath, { readonly: true });
  try {
    expect(
      reopened
        .query("SELECT spinEventId, spinMatchStatus FROM messages WHERE id = ?")
        .get(message.id),
    ).toEqual({ spinEventId: "472470", spinMatchStatus: "provisional" });
    expect(
      reopened
        .query("SELECT seconds, nanoseconds FROM sync_state WHERE slot = 1")
        .get(),
    ).toEqual(cursor);
  } finally {
    reopened.close();
  }
});

test("confirmation and unlink updates replace the cached match status", () => {
  const confirmed: PagerMessage = {
    ...message,
    spinEventId: "472470",
    spinMatchStatus: "confirmed",
  };
  const changes = {
    messages: [confirmed],
    removedIds: [],
    cursor: { seconds: 124, nanoseconds: 2 },
    reset: false,
  };
  cacheMessages("approved-device", [confirmed], changes);
  expect(
    cachedHistory("approved-device")?.messages.find(
      (item) => item.id === message.id,
    )?.spinMatchStatus,
  ).toBe("confirmed");
  cacheMessages("approved-device", [message], {
    ...changes,
    messages: [message],
  });
  expect(
    cachedHistory("approved-device")?.messages.find(
      (item) => item.id === message.id,
    )?.spinEventId,
  ).toBeNull();
  expect(
    cachedHistory("approved-device")?.messages.find(
      (item) => item.id === message.id,
    )?.spinMatchStatus,
  ).toBeNull();
  cacheMessages("approved-device", [confirmed], changes);
});

test("SPIN reports tolerate a late event document, share one row, and retain revisions offline", () => {
  expect(cachedSpinEvents("approved-device")).toEqual([]);
  const event = {
    id: "472470",
    title: "Požar, eksplozija",
    description: "Public SPIN report.",
    eventAt: "2026-10-09T12:27:37.000Z",
    municipality: "Ig",
    category: null,
    reportedAtLocal: null,
    latitude: 45.909,
    longitude: 14.549,
  };
  cacheSpinEvent("approved-device", event.id, event);
  expect(cachedSpinEvents("approved-device")).toEqual([event]);
  const second = { ...message, id: "another-unit", spinEventId: event.id };
  cacheMessages("approved-device", [second], {
    messages: [second],
    removedIds: [],
    cursor: { seconds: 124, nanoseconds: 2 },
    reset: false,
  });
  const revised = { ...event, description: "Revised public SPIN report." };
  cacheSpinEvent("approved-device", event.id, revised);
  expect(cachedSpinEvents("approved-device")).toEqual([revised]);
  expect(cachedSpinEvents("another-device")).toEqual([]);
  const reopened = new Database(databasePath, { readonly: true });
  try {
    expect(
      reopened
        .query("SELECT description FROM spin_events WHERE id = ?")
        .get(event.id),
    ).toEqual({ description: revised.description });
    expect(
      reopened
        .query("SELECT COUNT(*) AS count FROM messages WHERE spinEventId = ?")
        .get(event.id),
    ).toEqual({ count: 2 });
  } finally {
    reopened.close();
  }
  cacheSpinEvent("approved-device", event.id, null);
  expect(cachedSpinEvents("approved-device")).toEqual([]);
});

test("RIC snapshots replace rows atomically, empty snapshots clear them, and message sync stays independent", () => {
  const sync = cachedSync("approved-device");
  const units = [{ ric: 123, unitName: "Golo" }];
  cacheRicUnits("approved-device", units);
  expect(() =>
    cacheRicUnits("approved-device", [
      { ric: 123, unitName: "Golo" },
      { ric: 123, unitName: "Duplicate" },
    ]),
  ).toThrow();
  expect(cachedHistory("approved-device")?.units).toEqual(units);
  expect(cachedSync("approved-device")).toEqual(sync);
  cacheRicUnits("approved-device", []);
  expect(cachedHistory("approved-device")?.units).toEqual([]);
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
