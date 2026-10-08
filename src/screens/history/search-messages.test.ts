import { expect, test } from "bun:test";

import type { PagerMessage } from "@/pager/types";
import {
  indexMessages,
  searchMessages,
} from "@/screens/history/search-messages";

const messages: PagerMessage[] = [
  {
    id: 3,
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "Požar v Šiški. Žiga preveri zadnji vhod.",
    duplicateOf: null,
  },
  {
    id: 2,
    receivedAt: "2026-10-08T09:00:00Z",
    ric: 456,
    function: 0,
    type: "alpha",
    content: "Preveri vhod na severni strani.",
    duplicateOf: null,
  },
  {
    id: 1,
    receivedAt: "2026-10-08T08:00:00Z",
    ric: 123,
    function: 0,
    type: "tone",
    content: "",
    duplicateOf: null,
  },
];

test("search matches all words across padded RIC and full text regardless of case or accents", () => {
  const index = indexMessages(messages);
  expect(searchMessages(index, "  ZIGA   0000123 pozar ")).toEqual([
    messages[0],
  ]);
  expect(searchMessages(index, "vhod preveri")).toEqual(messages.slice(0, 2));
  expect(searchMessages(index, "šiški")).toEqual([messages[0]]);
  expect(searchMessages(index, "0000456 pozar")).toEqual([]);
  expect(searchMessages(index, "tone-only 0000123")).toEqual([messages[2]]);
});

test("clearing and changing search preserves original messages and order", () => {
  const index = indexMessages(messages);
  expect(searchMessages(index, " ")).toEqual(messages);
  expect(searchMessages(index, "vhod")[0]).toBe(messages[0]);
  expect(searchMessages(index, "0000123")).toEqual([messages[0], messages[2]]);
  expect(searchMessages(index, "unmatched")).toEqual([]);
  expect(searchMessages(index, "")).toEqual(messages);
});

test("reindexing uses current message text and removes stale matches", () => {
  const updated = { ...messages[0]!, content: "Intervencija zaključena." };
  const index = indexMessages([updated]);
  expect(searchMessages(index, "pozar")).toEqual([]);
  expect(searchMessages(index, "zakljucena")).toEqual([updated]);
});

test("search follows displayed spaces instead of matching decoder markers", () => {
  const message = { ...messages[0]!, content: "Test.<LF>Prejem javi vodji." };
  const index = indexMessages([message]);
  expect(searchMessages(index, "test. prejem")).toEqual([message]);
  expect(searchMessages(index, "lf")).toEqual([]);
});

test("unit renames update search for existing messages while RIC remains searchable", () => {
  const oldIndex = indexMessages(
    messages,
    new Map([[123, "Gasilska enota Šiška"]]),
  );
  expect(searchMessages(oldIndex, "enota siska 0000123")).toEqual([
    messages[0],
    messages[2],
  ]);
  const renamed = indexMessages(messages, new Map([[123, "Nova enota"]]));
  expect(searchMessages(renamed, "siska enota")).toEqual([]);
  expect(searchMessages(renamed, "nova enota")).toEqual([
    messages[0],
    messages[2],
  ]);
});
