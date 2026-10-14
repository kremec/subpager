import { expect, test } from "bun:test";
import {
  canGroupPages,
  isEcho,
  normalizeContent,
  pagerDay,
} from "./pager-group";
import type { Page } from "./radio/decoder";

const page: Page = {
  receivedAt: "2026-10-10T15:01:00Z",
  ric: 791033,
  function: 0,
  type: "alpha",
  content:
    "VAJA - GORI ŽAGA, ZAMOSTEC 19 - POGREŠANE OSEBE, IZVOZ JAVI NA CH39 - OP SODRAŽICA - VAJA",
};

test("matches different RICs and small decoding errors without changing the saved body", () => {
  for (const content of [
    page.content,
    page.content.toLowerCase().replace("žaga, ", "zaga,<CR><LF>"),
    page.content.replace("GORI", "G?RI"),
    page.content.replace("ŽAGA", "ŽAAGA"),
    page.content.replace("ŽAGA", "ŽGA"),
  ]) {
    const later = {
      ...page,
      ric: 791057,
      receivedAt: "2026-10-12T15:03:00Z",
      content,
    };
    expect(canGroupPages(page, later)).toBe(true);
  }
  expect(normalizeContent("ŠOLA<LF>GOLO<EOT><NUL>")).toBe("ŠOLA GOLO");
});

test("keeps changed addresses, channel numbers, short instructions and unrelated calls separate", () => {
  for (const content of [
    page.content.replace("19", "18"),
    page.content.replace("CH39", "CH38"),
    "POŽAR NA DRUGI LOKACIJI",
    page.content.replace("GORI", "??RI"),
  ])
    expect(canGroupPages(page, { ...page, content })).toBe(false);
  expect(
    canGroupPages(
      { ...page, content: "PREKLIC ZA KRVAVO PEČ" },
      { ...page, content: "PREKLIC ZA KRVAVO PEČ?" },
    ),
  ).toBe(false);
  expect(canGroupPages(page, { ...page, function: 1 })).toBe(false);
  expect(canGroupPages(page, { ...page, type: "numeric" })).toBe(false);
});

test("content matching is independent of time and RIC; daily grouping is applied by ingestion", () => {
  const later = { ...page, receivedAt: "2027-10-10T15:04:01Z", ric: 791057 };
  expect(canGroupPages(page, later)).toBe(true);
  const tone = { ...page, type: "tone" as const, content: "" };
  const anotherTone = { ...tone, ric: 791057, receivedAt: later.receivedAt };
  expect(canGroupPages(tone, anotherTone)).toBe(true);
});

test("pager days use Ljubljana midnight including daylight-saving changes", () => {
  expect(pagerDay("2026-10-12T21:59:59Z")).toBe("2026-10-12");
  expect(pagerDay("2026-10-12T22:00:00Z")).toBe("2026-10-13");
  expect(pagerDay("2026-12-12T22:59:59Z")).toBe("2026-12-12");
  expect(pagerDay("2026-12-12T23:00:00Z")).toBe("2026-12-13");
});

test("echoes match only the same RIC within 60 seconds of a retained reception", () => {
  const first = { ric: 790113, time: "2026-10-12T15:00:49.600Z" };
  expect(isEcho([first], { ...first, time: "2026-10-12T15:01:05.494Z" })).toBe(
    true,
  );
  expect(isEcho([first], { ...first, time: "2026-10-12T15:01:49.600Z" })).toBe(
    true,
  );
  expect(isEcho([first], { ...first, time: "2026-10-12T15:01:49.601Z" })).toBe(
    false,
  );
  expect(isEcho([first], { ...first, ric: 790193 })).toBe(false);
  expect(isEcho([first], { ...first, time: "2026-10-12T15:00:36.292Z" })).toBe(
    true,
  );
  expect(isEcho([first], { ...first, time: "2026-10-12T14:59:49.600Z" })).toBe(
    true,
  );
  expect(isEcho([first], { ...first, time: "2026-10-12T14:59:49.599Z" })).toBe(
    false,
  );
});
