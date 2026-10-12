import { expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import { formatReceivedAt } from "@/pager/format-message";
import type { PagerMessage } from "@/pager/types";

mock.module("react-native", () => ({ View: "View" }));
mock.module("@/components/ui/typography", () => ({ Typography: "Typography" }));
mock.module("@/pager/message-content", () => ({
  MessageContent: "MessageContent",
}));
mock.module("@/pager/spin-report", () => ({ SpinReport: "SpinReport" }));
mock.module("@/theme/use-theme", () => ({
  useTheme: () => ({ colors: {}, spacing: { xs: 4, sm: 8, lg: 16 } }),
}));

const { MessageRow } = await import("@/screens/history/message-row");

interface ElementProps {
  children?: ReactNode;
}

test("reception history keeps repeated RICs in chronological order above one message body", () => {
  const message: PagerMessage = {
    id: "event",
    receptions: [
      { ric: 790193, time: "2026-10-12T15:00:03Z" },
      { ric: 790113, time: "2026-10-12T15:00:01Z" },
      { ric: 790193, time: "2026-10-12T15:00:02Z" },
    ],
    function: 0,
    type: "alpha",
    content: "One stored message",
  };
  // Hermes does not implement Array.prototype.toSorted.
  Object.defineProperty(message.receptions, "toSorted", { value: undefined });
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise the component with its theme mocked.
  const row = MessageRow({
    message,
    unitNames: new Map([[790193, "PGD Example"]]),
  }) as ReactElement<ElementProps>;
  const children = row.props.children as ReactElement<ElementProps>[];
  const receptions = children[0]!.props
    .children as ReactElement<ElementProps>[];
  expect(
    receptions.map((reception) =>
      (reception.props.children as ReactElement<ElementProps>[]).map(
        (label) => label.props.children,
      ),
    ),
  ).toEqual([
    ["0790113", formatReceivedAt("2026-10-12T15:00:01Z")],
    [
      "PGD\u00a0Example\u00a0(0790193)",
      formatReceivedAt("2026-10-12T15:00:02Z"),
    ],
    [
      "PGD\u00a0Example\u00a0(0790193)",
      formatReceivedAt("2026-10-12T15:00:03Z"),
    ],
  ]);
  expect(children[1]!.type).toBe("MessageContent");
  expect(message.receptions[0]!.time).toBe("2026-10-12T15:00:03Z");
});
