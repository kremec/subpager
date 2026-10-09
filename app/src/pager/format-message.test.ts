import { expect, test } from "bun:test";

import {
  formatMessageContent,
  formatReceivedAt,
  formatRic,
  formatRicUnit,
} from "@/pager/format-message";

test("shows day/month/year and 24-hour time in the device timezone", () => {
  const afternoon = new Date(2026, 9, 8, 15, 5).toISOString();
  const midnight = new Date(2026, 9, 8, 0, 5).toISOString();
  expect(formatReceivedAt(afternoon)).toBe("08/10/2026, 15:05");
  expect(formatReceivedAt(midnight)).toBe("08/10/2026, 00:05");
});

test("uses the current unit name while keeping the padded RIC visible", () => {
  expect(formatRicUnit(90473, "Unit name")).toBe("Unit name (0090473)");
  expect(formatRicUnit(90473)).toBe("0090473");
});

test("shows the seven-digit RIC without a label", () => {
  expect(formatRic(90033)).toBe("0090033");
  expect(formatRic(2097151)).toBe("2097151");
});

test("renders decoder line-break markers as spaces without joining words", () => {
  expect(formatMessageContent("Test pozivnika.<LF>Prejem javi vodji.")).toBe(
    "Test pozivnika. Prejem javi vodji.",
  );
  expect(formatMessageContent("A<CR><LF>B<CR>C\r\nD\rE\nF")).toBe(
    "A B C D E\nF",
  );
  expect(formatMessageContent("ČŠŽ <test> ")).toBe("ČŠŽ <test> ");
});
