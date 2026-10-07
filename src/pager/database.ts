import { openDatabaseSync } from "expo-sqlite";

import type { PagerMessage } from "@/pager/types";

const database = openDatabaseSync("subpager.db");

export function initializeDatabase() {
  database.execSync(
    "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, json TEXT NOT NULL);",
  );
}

export function cacheMessages(messages: PagerMessage[]) {
  database.withTransactionSync(() => {
    for (const message of messages)
      database.runSync(
        "INSERT OR REPLACE INTO messages (id, json) VALUES (?, ?)",
        message.id,
        JSON.stringify(message),
      );
    database.runSync(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)",
    );
  });
}

export function cachedMessages(): PagerMessage[] {
  return database
    .getAllSync<{ json: string }>(
      "SELECT json FROM messages ORDER BY id DESC LIMIT 500",
    )
    .map((row) => JSON.parse(row.json) as PagerMessage);
}

export function cachedMessage(id: number): PagerMessage | undefined {
  const row = database.getFirstSync<{ json: string }>(
    "SELECT json FROM messages WHERE id = ?",
    id,
  );
  return row ? (JSON.parse(row.json) as PagerMessage) : undefined;
}

export function clearMessages() {
  database.runSync("DELETE FROM messages");
}
