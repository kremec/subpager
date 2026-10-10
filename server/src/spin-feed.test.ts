import { expect, test } from "bun:test";
import { hasSpinReport, parseSpinDetail, parseSpinFeed } from "./spin-feed";

function item(
  id = "472557",
  description = "Ob 13.18 je v Dobrovi prišlo do nesreče.",
): string {
  return `<item><title>Prometna nesreča</title><link>https://spin3.sos112.si/javno/zemljevid/${id}</link><description>${description}</description><guid>https://spin3.sos112.si/javno/zemljevid/${id}</guid><pubDate>Sat, 10 Oct 2026 11:18:04 GMT</pubDate></item>`;
}

function feed(items: string): string {
  return `<rss version="2.0"><channel><title>SPIN</title>${items}</channel></rss>`;
}

test("RSS decodes escaped Slovenian reports and converts the event time to UTC", () => {
  expect(
    parseSpinFeed(
      feed(item("472557", "Šiška &amp; Dobrova &lt;objekt&gt; &#269;")),
    ),
  ).toEqual([
    {
      id: "472557",
      title: "Prometna nesreča",
      description: "Šiška & Dobrova <objekt> č",
      eventAt: "2026-10-10T11:18:04.000Z",
    },
  ]);
  expect(parseSpinFeed(feed(""))).toEqual([]);
  expect(parseSpinFeed("<rss><channel /></rss>")).toEqual([]);
});

test("RSS rejects malformed items and conflicting identities without returning a partial feed", () => {
  for (const xml of [
    "<rss><channel>",
    "<html><body>Unavailable</body></html>",
    feed(item() + item()),
    feed(
      item().replace(
        "<guid>https://spin3.sos112.si/javno/zemljevid/472557",
        "<guid>https://spin3.sos112.si/javno/zemljevid/472558",
      ),
    ),
    feed(item().replace("Sat, 10 Oct 2026 11:18:04 GMT", "not a date")),
    feed(item().replaceAll("/472557", "/invalid")),
  ]) {
    expect(() => parseSpinFeed(xml)).toThrow();
  }
});

test("detail metadata preserves local report time and the approximate coordinates", () => {
  expect(
    parseSpinDetail({
      statusCode: 200,
      value: {
        obcinaNaziv: "Dobrova-Polhov Gradec",
        dogodekNaziv: "Nesreče v cestnem prometu",
        prijavaCas: "2026-10-10T13:21:53.363",
        wgsLatApprox: 46.05,
        wgsLonApprox: 14.417,
        besedilo: " Ob 13.18 sta trčila kolesar in osebno vozilo. ",
      },
    }),
  ).toEqual({
    municipality: "Dobrova-Polhov Gradec",
    category: "Nesreče v cestnem prometu",
    reportedAtLocal: "2026-10-10T13:21:53.363",
    latitude: 46.05,
    longitude: 14.417,
    description: "Ob 13.18 sta trčila kolesar in osebno vozilo.",
  });
  expect(parseSpinDetail({ statusCode: 200 })).toEqual({});
  expect(
    parseSpinDetail({ value: { besedilo: "  ", wgsLatApprox: null } }),
  ).toEqual({});
  expect(
    parseSpinDetail({
      value: { besedilo: "Grosuplje", obcinaNaziv: "Grosuplje" },
    }),
  ).toEqual({ municipality: "Grosuplje" });
});

test("detail rejects invalid coordinates, field types, local dates, and unsuccessful responses", () => {
  for (const payload of [
    null,
    { statusCode: 500 },
    { value: [] },
    { value: { obcinaNaziv: 12 } },
    { value: { wgsLatApprox: 91 } },
    { value: { wgsLonApprox: "14.1" } },
    { value: { prijavaCas: "2026-02-30T13:21:53" } },
    { value: { prijavaCas: "2026-10-10T13:21:53Z" } },
  ]) {
    expect(() => parseSpinDetail(payload)).toThrow();
  }
});

test("municipality-only early entries cannot be treated as narrative reports", () => {
  const event = parseSpinFeed(feed(item("472569", "Grosuplje")))[0]!;
  expect(hasSpinReport({ ...event, municipality: "Grosuplje" })).toBe(false);
  expect(hasSpinReport(event, new Set(["Grosuplje"]))).toBe(false);
  expect(hasSpinReport({ ...event, description: " " })).toBe(false);
  expect(
    hasSpinReport({
      ...event,
      municipality: "Grosuplje",
      description: "Ob 15.22 se je pri delu poškodoval delavec.",
    }),
  ).toBe(true);
});
