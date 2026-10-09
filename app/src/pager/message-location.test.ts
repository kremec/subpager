import { expect, test } from "bun:test";

import { messageLocation } from "@/pager/message-location";
import type { PagerMessage } from "@/pager/types";

const message: PagerMessage = {
  id: "message-1",
  receivedAt: "2026-10-08T10:00:00Z",
  ric: 123,
  function: 0,
  type: "alpha",
  content: "VAJA!!! GORI V ŠOLI GOLO, POGREŠA SE 1 OSEBA.",
  duplicateOf: null,
};

test("only a verbatim extracted location becomes a Maps link", () => {
  expect(messageLocation({ ...message, location: "ŠOLI GOLO" })).toEqual({
    before: "VAJA!!! GORI V ",
    location: "ŠOLI GOLO",
    after: ", POGREŠA SE 1 OSEBA.",
    url: "https://www.google.com/maps/search/?api=1&query=%C5%A0OLI%20GOLO%2C%20Slovenija",
  });
  expect(messageLocation({ ...message, location: "OŠ Golo" })).toBeNull();
  expect(messageLocation({ ...message, location: "" })).toBeNull();
  expect(messageLocation({ ...message, location: null })).toBeNull();
  expect(messageLocation(message)).toBeNull();
});
