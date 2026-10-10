import { expect, test } from "bun:test";
import { readLocationResponse } from "./location";

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
