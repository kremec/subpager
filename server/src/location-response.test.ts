import { expect, test } from "bun:test";
import { parseLocationResult, readLocationResponse } from "./location";

test.each([
  ["TRZIN  TRZIN  LJUBLJANSKA CESTA 15C", "LJUBLJANSKA CESTA 15C"],
  ["RIBNICA DOLENJA VAS HUMEC 2", "HUMEC 2"],
])(
  "keeps destination %s unchanged and selects its source postal address",
  (location, address) => {
    expect(
      parseLocationResult(
        JSON.stringify({ location, address }),
        `NESREČA - ${location}.`,
      ),
    ).toEqual({ location, address });
  },
);

test.each([
  [
    "TRZIN LJUBLJANSKA CESTA 15C",
    "LJUBLJANSKA CESTA 15",
    "TRZIN LJUBLJANSKA CESTA 15C",
  ],
  [
    "TRZIN LJUBLJANSKA CESTA 15",
    "LJUBLJANSKA CESTA 15",
    "TRZIN LJUBLJANSKA CESTA 15C",
  ],
  [
    "TRZIN LJUBLJANSKA CESTA 15 C",
    "LJUBLJANSKA CESTA 15",
    "TRZIN LJUBLJANSKA CESTA 15 C",
  ],
  [
    "TRZIN LJUBLJANSKA CESTA 15C",
    "LJUBLJANSKA CESTA 15c",
    "TRZIN LJUBLJANSKA CESTA 15C",
  ],
  ["TRZIN LJUBLJANSKA CESTA 15C", "ESTA 15C", "TRZIN LJUBLJANSKA CESTA 15C"],
  [
    "TRZIN LJUBLJANSKA CESTA 15C",
    "GOLO 40",
    "TRZIN LJUBLJANSKA CESTA 15C, GOLO 40",
  ],
  ["TRZIN LJUBLJANSKA CESTA", "LJUBLJANSKA CESTA", "TRZIN LJUBLJANSKA CESTA"],
])(
  "rejects unsupported or truncated postal address %s / %s",
  (location, address, content) => {
    expect(() =>
      parseLocationResult(JSON.stringify({ location, address }), content),
    ).toThrow();
  },
);

test("allows a destination without a numbered address and requires both output fields", () => {
  expect(
    parseLocationResult(
      '{"location":"PRI HOFERJU","address":null}',
      "NESREČA PRI HOFERJU",
    ),
  ).toEqual({ location: "PRI HOFERJU", address: null });
  expect(() => parseLocationResult('{"location":null}', "KANAL 15")).toThrow();
  expect(() =>
    parseLocationResult('{"location":null,"address":"GOLO 40"}', "GOLO 40"),
  ).toThrow();
});

test("accepts a corrected complete house number after an earlier address sharing its prefix", () => {
  expect(
    parseLocationResult(
      '{"location":"GOLO 15","address":"GOLO 15"}',
      "NE GOLO 15C, PRAVI NASLOV GOLO 15.",
    ),
  ).toEqual({ location: "GOLO 15", address: "GOLO 15" });
});

test("Responses output uses only the final answer when commentary is also present", () => {
  const final = '{"location":"Pavsiceva ulica 18"}';
  expect(
    readLocationResponse({
      status: "completed",
      output: [
        {
          type: "message",
          phase: "commentary",
          content: [{ type: "output_text", text: "Checking the address." }],
        },
        {
          type: "message",
          phase: "final_answer",
          content: [{ type: "output_text", text: final }],
        },
      ],
    }),
  ).toBe(final);
});

test("a completed response with only commentary is not a usable result", () => {
  expect(() =>
    readLocationResponse({
      status: "completed",
      output: [
        {
          type: "message",
          phase: "commentary",
          content: [{ type: "output_text", text: '{"location":null}' }],
        },
      ],
    }),
  ).toThrow("Expected one location result");
});

test("an incomplete response is rejected even when it contains valid final JSON", () => {
  expect(() =>
    readLocationResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          phase: "final_answer",
          content: [{ type: "output_text", text: '{"location":null}' }],
        },
      ],
    }),
  ).toThrow("Location response did not complete");
});
