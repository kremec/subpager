import { expect, spyOn, test } from "bun:test";
import { createErrorReporter, logInfo } from "./log";

test("runtime logs keep received text on one timestamped line without terminal controls", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    logInfo("Received ČŠŽ\nforged\x1b[31m\u2028line");
    expect(output.mock.calls[0]![0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO Received ČŠŽ\\u000aforged\\u001b\[31m\\u2028line$/,
    );
    logInfo("x".repeat(10_000));
    expect(output.mock.calls[1]![0].length).toBeLessThan(4100);
  } finally {
    output.mockRestore();
  }
});

test("repeated errors produce a five-minute reminder and one recovery, while changed failures remain visible", () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const info = spyOn(console, "log").mockImplementation(() => {});
  try {
    const report = createErrorReporter("Firebase sync");
    report(null);
    report("Quota exceeded");
    for (let i = 0; i < 299; i++) {
      now += 1000;
      report("Quota exceeded");
    }
    expect(errors).toHaveBeenCalledTimes(1);
    now += 1000;
    report("Quota exceeded");
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[1]![0]).toEndWith("Quota exceeded; still failing");
    report("Offline");
    expect(errors).toHaveBeenCalledTimes(3);
    report(null);
    report(null);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toEndWith("Firebase sync recovered");
    report("Quota exceeded");
    expect(errors).toHaveBeenCalledTimes(4);
  } finally {
    clock.mockRestore();
    errors.mockRestore();
    info.mockRestore();
  }
});
