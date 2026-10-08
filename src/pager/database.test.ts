import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import type { PagerMessage } from "@/pager/types";

const sqlite = new Database(":memory:");
mock.module("expo-sqlite", () => ({
  openDatabaseSync: () => ({
    execSync: (sql: string) => sqlite.exec(sql),
    withTransactionSync: (task: () => void) => sqlite.transaction(task)(),
    runSync: (sql: string, ...params: SQLQueryBindings[]) =>
      sqlite.query(sql).run(...params),
    getAllSync: <T>(sql: string, ...params: SQLQueryBindings[]) =>
      sqlite.query<T, SQLQueryBindings[]>(sql).all(...params),
    getFirstSync: <T>(sql: string, ...params: SQLQueryBindings[]) =>
      sqlite.query<T, SQLQueryBindings[]>(sql).get(...params),
  }),
}));

const {
  initializeDatabase,
  cacheMessages,
  cachedMessages,
  clearMessages,
  cacheRicUnits,
  cachedRicUnits,
  subscribeToMessages,
} = await import("@/pager/database");

test("message batches retain full history and update existing messages", () => {
  initializeDatabase();

  const messages: PagerMessage[] = Array.from({ length: 1500 }, (_, index) => ({
    id: `message-${index + 1}`,
    receivedAt: new Date(
      Date.parse("2026-10-08T10:00:00Z") + index * 1000,
    ).toISOString(),
    ric: 123,
    function: 0,
    type: "alpha",
    content: String(index + 1),
    duplicateOf: null,
  }));
  cacheMessages(messages);
  expect(cachedMessages()).toHaveLength(1500);
  expect(cachedMessages().at(-1)?.id).toBe("message-1");
  cacheMessages([{ ...messages[0]!, content: "Changed content" }]);
  expect(cachedMessages().at(-1)?.content).toBe("Changed content");
  expect(cachedMessages()).toHaveLength(1500);

  cacheMessages(messages.slice(1));
  cacheMessages([]);
  expect(cachedMessages()).toHaveLength(1500);
  expect(cachedMessages().at(-1)?.id).toBe("message-1");

  cacheMessages([
    {
      ...messages[0]!,
      id: "message-new",
      receivedAt: "2026-10-08T11:00:00Z",
      content: "New message",
    },
  ]);
  expect(cachedMessages()).toHaveLength(1501);
  expect(cachedMessages()[0]?.content).toBe("New message");

  clearMessages();
  expect(cachedMessages()).toEqual([]);
});

test("open screens are notified after new message batches commit and access is revoked", () => {
  const observed: number[] = [];
  const unsubscribe = subscribeToMessages(() => {
    observed.push(cachedMessages().length);
  });
  const message: PagerMessage = {
    id: "message-1",
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "Test",
    duplicateOf: null,
  };
  cacheMessages([message]);
  cacheMessages([message]);
  cacheMessages([{ ...message, location: "Test" }]);
  cacheMessages([]);
  expect(observed).toEqual([1, 1]);
  expect(cachedMessages()[0]?.location).toBe("Test");
  clearMessages();
  expect(observed).toEqual([1, 1, 0]);
  unsubscribe();
  cacheMessages([]);
  expect(observed).toEqual([1, 1, 0]);
});

test("unit mappings are cached, renamed and removed separately, then erased on revocation", () => {
  cacheRicUnits([
    { ric: 123, unitName: "Old name" },
    { ric: 456, unitName: "Another unit" },
  ]);
  expect(cachedRicUnits().get(123)).toBe("Old name");
  cacheRicUnits([{ ric: 123, unitName: "New name" }]);
  expect(cachedRicUnits().get(123)).toBe("New name");
  expect(cachedRicUnits().has(456)).toBe(false);
  expect(() =>
    cacheRicUnits([
      { ric: 123, unitName: "A" },
      { ric: 123, unitName: "B" },
    ]),
  ).toThrow();
  expect(cachedRicUnits().get(123)).toBe("New name");
  clearMessages();
  expect(cachedRicUnits().size).toBe(0);
});

test("cached history uses receive time rather than native ID order", () => {
  const message: PagerMessage = {
    id: "zz-old",
    receivedAt: "2026-10-08T09:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "Old",
    duplicateOf: null,
  };
  cacheMessages([
    message,
    {
      ...message,
      id: "aa-new",
      receivedAt: "2026-10-08T10:00:00Z",
      content: "New",
    },
  ]);
  expect(cachedMessages().map((item) => item.id)).toEqual(["aa-new", "zz-old"]);
  clearMessages();
});
