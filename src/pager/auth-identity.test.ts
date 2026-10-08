import { expect, test } from "bun:test";

import { authIdentity } from "@/pager/auth-identity";

test("the auth identity remains stable across sessions and distinguishes devices", () => {
  const token = (sub: string) =>
    `header.${btoa(JSON.stringify({ sub })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.signature`;
  expect(authIdentity(token("approved-device|session-1"))).toBe(
    "approved-device",
  );
  expect(authIdentity(token("approved-device|session-2"))).toBe(
    "approved-device",
  );
  expect(authIdentity(token("new-device|session-3"))).toBe("new-device");
  expect(authIdentity(null)).toBeNull();
  expect(authIdentity("invalid")).toBeNull();
  expect(authIdentity("header.invalid.signature")).toBeNull();
});
