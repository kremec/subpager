import { expect, test } from "bun:test";

import { loadHistoryPage } from "@/pager/history-backfill";
import type { MessagePage, PagerMessage } from "@/pager/types";

function message(id: number): PagerMessage {
  return {
    id,
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: String(id),
    duplicateOf: null,
  };
}

function history() {
  const messages = Array.from({ length: 150 }, (_, index) =>
    message(150 - index),
  );
  const requested: (number | undefined)[] = [];
  async function getPage(before?: number): Promise<MessagePage> {
    requested.push(before);
    const page = messages
      .filter((item) => before === undefined || item.id < before)
      .slice(0, 50);
    return {
      messages: page,
      nextCursor: page.length === 50 ? page.at(-1)!.id : null,
    };
  }
  return { getPage, requested };
}

test("reconnecting fills a gap longer than one cloud page", async () => {
  const { getPage, requested } = history();
  const page = await loadHistoryPage({
    newestId: 40,
    getPage,
    cancelled: () => false,
  });
  expect(requested).toEqual([undefined, 101, 51]);
  expect(
    page?.messages.filter((item) => item.id > 40).map((item) => item.id),
  ).toEqual(Array.from({ length: 110 }, (_, index) => 150 - index));
});

test("initial history and older paging fetch only one page", async () => {
  const { getPage, requested } = history();
  const first = await loadHistoryPage({
    newestId: 0,
    getPage,
    cancelled: () => false,
  });
  const older = await loadHistoryPage({
    newestId: 150,
    before: first!.nextCursor!,
    getPage,
    cancelled: () => false,
  });
  expect(requested).toEqual([undefined, 101]);
  expect(older?.messages[0]?.id).toBe(100);
  expect(older?.messages.at(-1)?.id).toBe(51);
});

test("revoked or changed access discards an in-flight backfill", async () => {
  const { getPage, requested } = history();
  const page = await loadHistoryPage({
    newestId: 40,
    getPage,
    cancelled: () => requested.length === 2,
  });
  expect(requested).toEqual([undefined, 101]);
  expect(page).toBeNull();
});

test("revocation while a cloud request is pending discards its result before effect cleanup", async () => {
  const response = Promise.withResolvers<MessagePage>();
  let approved = true;
  const page = loadHistoryPage({
    newestId: 0,
    getPage: () => response.promise,
    cancelled: () => !approved,
  });
  approved = false;
  response.resolve({ messages: [message(151)], nextCursor: null });
  expect(await page).toBeNull();
});
