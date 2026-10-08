import { deleteDatabaseSync, openDatabaseSync } from "expo-sqlite";

import type { PagerMessage, RicUnit } from "@/pager/types";

let database: ReturnType<typeof openDatabaseSync> | undefined;
const DATABASE_NAME = "subpager-cache.db";

function getDatabase() {
  if (!database) {
    const opened = openDatabaseSync(DATABASE_NAME);
    try {
      opened.execSync(
        `CREATE TABLE IF NOT EXISTS history (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          uid TEXT NOT NULL,
          messages TEXT NOT NULL,
          units TEXT NOT NULL
        );`,
      );
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
    database.getFirstSync("SELECT uid FROM history WHERE uid = ?", uid) !== null
  );
}

export function cacheApproval(uid: string, approved: boolean) {
  const cache = getDatabase();
  if (!approved) {
    if (!cachedApproval(uid)) return;
    try {
      cache.runSync("DELETE FROM history WHERE uid = ?", uid);
    } catch {
      cache.closeSync();
      database = undefined;
      deleteDatabaseSync(DATABASE_NAME);
    }
    return;
  }
  if (cachedApproval(uid)) return;
  cache.withTransactionSync(() => {
    cache.runSync("DELETE FROM history");
    cache.runSync(
      "INSERT INTO history (slot, uid, messages, units) VALUES (1, ?, '[]', '[]')",
      uid,
    );
  });
}

export function cachedHistory(uid: string) {
  const database = getDatabase();
  const row = database.getFirstSync<{ messages: string; units: string }>(
    "SELECT messages, units FROM history WHERE uid = ?",
    uid,
  );
  if (!row) return null;
  return {
    messages: JSON.parse(row.messages) as PagerMessage[],
    units: JSON.parse(row.units) as RicUnit[],
  };
}

export function cacheMessages(uid: string, messages: PagerMessage[]) {
  const database = getDatabase();
  database.runSync(
    "UPDATE history SET messages = ? WHERE uid = ?",
    JSON.stringify(messages),
    uid,
  );
}

export function cacheRicUnits(uid: string, units: RicUnit[]) {
  const database = getDatabase();
  database.runSync(
    "UPDATE history SET units = ? WHERE uid = ?",
    JSON.stringify(units),
    uid,
  );
}
