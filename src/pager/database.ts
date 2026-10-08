import { openDatabaseSync } from "expo-sqlite";

import type { PagerMessage, RicUnit } from "@/pager/types";

const database = openDatabaseSync("subpager.db");
const listeners = new Set<() => void>();

export function subscribeToMessages(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function initializeDatabase() {
  database.execSync(
    `PRAGMA journal_mode = WAL;
     CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS ric_units (ric INTEGER PRIMARY KEY, unit_name TEXT NOT NULL);`,
  );
}

export function cacheMessages(messages: PagerMessage[]) {
  if (messages.length === 0) return;
  let inserted = 0;
  database.withTransactionSync(() => {
    for (const message of messages)
      inserted += database.runSync(
        "INSERT OR IGNORE INTO messages (id, json) VALUES (?, ?)",
        message.id,
        JSON.stringify(message),
      ).changes;
  });
  if (inserted > 0) for (const listener of listeners) listener();
}

export function cacheRicUnits(units: RicUnit[]) {
  database.withTransactionSync(() => {
    database.runSync("DELETE FROM ric_units");
    for (const unit of units)
      database.runSync(
        "INSERT INTO ric_units (ric, unit_name) VALUES (?, ?)",
        unit.ric,
        unit.unitName,
      );
  });
  for (const listener of listeners) listener();
}

export function cachedRicUnits(): Map<number, string> {
  return new Map(
    database
      .getAllSync<RicUnit>(
        "SELECT ric, unit_name AS unitName FROM ric_units ORDER BY ric",
      )
      .map((unit) => [unit.ric, unit.unitName]),
  );
}

export function cachedMessages(): PagerMessage[] {
  return database
    .getAllSync<{ json: string }>("SELECT json FROM messages ORDER BY id DESC")
    .map((row) => JSON.parse(row.json) as PagerMessage);
}

export function clearMessages() {
  database.withTransactionSync(() => {
    database.runSync("DELETE FROM messages");
    database.runSync("DELETE FROM ric_units");
  });
  for (const listener of listeners) listener();
}
