import { expect, test } from "bun:test";
import { canGroupPages, normalizeContent } from "./pager-group";
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

test("matching content groups without a time or RIC cutoff, including tone calls", () => {
  const later = { ...page, receivedAt: "2027-10-10T15:04:01Z", ric: 791057 };
  expect(canGroupPages(page, later)).toBe(true);
  const tone = { ...page, type: "tone" as const, content: "" };
  const anotherTone = { ...tone, ric: 791057, receivedAt: later.receivedAt };
  expect(canGroupPages(tone, anotherTone)).toBe(true);
});
