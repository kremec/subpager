import { deleteDatabaseSync, openDatabaseSync } from "expo-sqlite";

import type {
  CachedSync,
  MessageChanges,
  PagerMessage,
  RicUnit,
  SpinEvent,
} from "@/pager/types";

let database: ReturnType<typeof openDatabaseSync> | undefined;
const DATABASE_NAME = "subpager-cache.db";

function getDatabase() {
  if (!database) {
    const opened = openDatabaseSync(DATABASE_NAME);
    try {
      opened.withTransactionSync(() => {
        opened.execSync(`
          CREATE TABLE IF NOT EXISTS approval (uid TEXT PRIMARY KEY NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY NOT NULL,
            receivedAt TEXT NOT NULL,
            ric INTEGER NOT NULL,
            function INTEGER NOT NULL,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            duplicateOf TEXT,
            location TEXT,
            spinEventId TEXT,
            spinMatchStatus TEXT
          );
          CREATE TABLE IF NOT EXISTS ric_units (
            ric INTEGER PRIMARY KEY,
            unitName TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS spin_events (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            eventAt TEXT NOT NULL,
            municipality TEXT,
            category TEXT,
            reportedAtLocal TEXT,
            latitude REAL,
            longitude REAL
          );
          CREATE TABLE IF NOT EXISTS sync_state (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            initialized INTEGER NOT NULL DEFAULT 0,
            seconds INTEGER NOT NULL DEFAULT 0,
            nanoseconds INTEGER NOT NULL DEFAULT 0
          );
        `);
        if (
          !opened
            .getAllSync<{ name: string }>("PRAGMA table_info(messages)")
            .some((column) => column.name === "spinEventId")
        ) {
          opened.execSync("ALTER TABLE messages ADD COLUMN spinEventId TEXT");
        }
        if (
          !opened
            .getAllSync<{ name: string }>("PRAGMA table_info(messages)")
            .some((column) => column.name === "spinMatchStatus")
        ) {
          opened.execSync(
            "ALTER TABLE messages ADD COLUMN spinMatchStatus TEXT",
          );
        }
        if (
          opened.getFirstSync<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history'",
          )
        ) {
          opened.execSync(`
            INSERT INTO approval (uid) SELECT uid FROM history;
            INSERT INTO messages
              (id, receivedAt, ric, function, type, content, duplicateOf, location)
            SELECT
              json_extract(value, '$.id'), json_extract(value, '$.receivedAt'),
              json_extract(value, '$.ric'), json_extract(value, '$.function'),
              json_extract(value, '$.type'), json_extract(value, '$.content'),
              json_extract(value, '$.duplicateOf'), json_extract(value, '$.location')
            FROM history, json_each(history.messages);
            INSERT INTO ric_units (ric, unitName)
            SELECT json_extract(value, '$.ric'), json_extract(value, '$.unitName')
            FROM history, json_each(history.units);
            DROP TABLE history;
          `);
        }
        if (
          opened.getFirstSync<{ user_version: number }>("PRAGMA user_version")!
            .user_version < 2
        ) {
          // Replay once for caches that dropped SPIN links or saved deletion markers
          // as ordinary messages before their app bundle supported removals.
          opened.execSync("DELETE FROM sync_state; PRAGMA user_version = 2;");
        }
      });
    } catch (error) {
      opened.closeSync();
      throw error;
    }
    database = opened;
  }
  return database;
}

export function initializeDatabase() {
  getDatabase();
}

export function cachedApproval(uid: string) {
  const database = getDatabase();
  return (
    database.getFirstSync<{ uid: string }>(
      "SELECT uid FROM approval WHERE uid = ?",
      uid,
    ) !== null
  );
}

export function cacheApproval(uid: string, approved: boolean) {
  const cache = getDatabase();
  if (approved === cachedApproval(uid)) return;
  try {
    cache.withTransactionSync(() => {
      cache.execSync(
        "DELETE FROM messages; DELETE FROM spin_events; DELETE FROM ric_units; DELETE FROM sync_state; DELETE FROM approval;",
      );
      if (approved) cache.runSync("INSERT INTO approval (uid) VALUES (?)", uid);
    });
  } catch (error) {
    if (approved) throw error;
    cache.closeSync();
    database = undefined;
    deleteDatabaseSync(DATABASE_NAME);
  }
}

export function cachedSpinEvents(uid: string) {
  if (!cachedApproval(uid)) return [];
  return getDatabase().getAllSync<SpinEvent>(
    "SELECT * FROM spin_events WHERE id IN (SELECT spinEventId FROM messages)",
  );
}

export function cacheSpinEvent(
  uid: string,
  id: string,
  event: SpinEvent | null,
) {
  if (!cachedApproval(uid)) return false;
  const database = getDatabase();
  if (!event) {
    database.runSync("DELETE FROM spin_events WHERE id = ?", id);
    return true;
  }
  database.runSync(
    `INSERT INTO spin_events
      (id, title, description, eventAt, municipality, category, reportedAtLocal, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, description = excluded.description,
      eventAt = excluded.eventAt, municipality = excluded.municipality,
      category = excluded.category, reportedAtLocal = excluded.reportedAtLocal,
      latitude = excluded.latitude, longitude = excluded.longitude`,
    id,
    event.title,
    event.description,
    event.eventAt,
    event.municipality ?? null,
    event.category ?? null,
    event.reportedAtLocal ?? null,
    event.latitude ?? null,
    event.longitude ?? null,
  );
  return true;
}

export function cachedHistory(uid: string) {
  if (!cachedApproval(uid)) return null;
  const database = getDatabase();
  return {
    messages: database.getAllSync<PagerMessage>(
      "SELECT * FROM messages ORDER BY receivedAt DESC, id DESC",
    ),
    units: database.getAllSync<RicUnit>("SELECT * FROM ric_units ORDER BY ric"),
  };
}

export function cachedSync(uid: string): CachedSync {
  const saved = cachedApproval(uid)
    ? getDatabase().getFirstSync<{
        initialized: number;
        seconds: number;
        nanoseconds: number;
      }>("SELECT * FROM sync_state WHERE slot = 1")
    : null;
  return {
    initialized: saved?.initialized === 1,
    cursor: {
      seconds: saved?.seconds ?? 0,
      nanoseconds: saved?.nanoseconds ?? 0,
    },
  };
}

export function cacheMessages(
  uid: string,
  messages: PagerMessage[],
  changes?: MessageChanges,
) {
  if (!cachedApproval(uid)) return false;
  const database = getDatabase();
  database.withTransactionSync(() => {
    if (!changes || changes.reset) database.execSync("DELETE FROM messages");
    for (const id of changes?.removedIds ?? []) {
      database.runSync("DELETE FROM messages WHERE id = ?", id);
    }
    for (const message of messages) {
      database.runSync(
        `INSERT INTO messages
          (id, receivedAt, ric, function, type, content, duplicateOf, location, spinEventId, spinMatchStatus)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ${
            changes
              ? `ON CONFLICT(id) DO UPDATE SET
            receivedAt = excluded.receivedAt, ric = excluded.ric,
            function = excluded.function, type = excluded.type,
            content = excluded.content, duplicateOf = excluded.duplicateOf,
            location = excluded.location, spinEventId = excluded.spinEventId,
            spinMatchStatus = excluded.spinMatchStatus`
              : ""
          }`,
        message.id,
        message.receivedAt,
        message.ric,
        message.function,
        message.type,
        message.content,
        message.duplicateOf,
        message.location ?? null,
        message.spinEventId ?? null,
        message.spinMatchStatus ?? null,
      );
    }
    if (changes) {
      database.runSync(
        `INSERT INTO sync_state (slot, initialized, seconds, nanoseconds)
          VALUES (1, 1, ?, ?) ON CONFLICT(slot) DO UPDATE SET
          initialized = 1, seconds = excluded.seconds, nanoseconds = excluded.nanoseconds`,
        changes.cursor.seconds,
        changes.cursor.nanoseconds,
      );
    }
  });
  return true;
}

export function cacheRicUnits(uid: string, units: RicUnit[]) {
  if (!cachedApproval(uid)) return false;
  const database = getDatabase();
  database.withTransactionSync(() => {
    database.execSync("DELETE FROM ric_units");
    for (const unit of units) {
      database.runSync(
        "INSERT INTO ric_units (ric, unitName) VALUES (?, ?)",
        unit.ric,
        unit.unitName,
      );
    }
  });
  return true;
}
