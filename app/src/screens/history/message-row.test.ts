import { beforeEach, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";

const react = await import("react");
type LayoutState = number | Record<number, number>;
const states: LayoutState[] = [];
let stateIndex = 0;
mock.module("react", () => ({
  ...react,
  useState: (initial: LayoutState) => {
    const index = stateIndex++;
    states[index] ??= initial;
    return [
      states[index],
      (value: LayoutState | ((current: LayoutState) => LayoutState)) => {
        states[index] =
          typeof value === "function" ? value(states[index]!) : value;
      },
    ];
  },
}));
mock.module("react-native", () => ({ View: "View" }));
mock.module("@/components/ui/typography", () => ({ Typography: "Typography" }));
mock.module("@/pager/message-content", () => ({
  MessageContent: "MessageContent",
}));
mock.module("@/pager/spin-report", () => ({ SpinReport: "SpinReport" }));
mock.module("@/theme/use-theme", () => ({
  useTheme: () => ({ colors: {}, spacing: { md: 12 } }),
}));

const { MessageRow } = await import("@/screens/history/message-row");

interface ElementProps {
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  style?: { width?: string; flexShrink?: number };
}

function render(rics: number[], unitNames?: ReadonlyMap<number, string>) {
  stateIndex = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise native layout callbacks without a native renderer.
  const row = MessageRow({
    message: {
      id: "message",
      rics,
      receivedAt: "2026-10-12T15:00:00Z",
      function: 0,
      type: "alpha",
      content: "Test",
    },
    unitNames,
  }) as ReactElement<ElementProps>;
  return (row.props.children as ReactElement<ElementProps>[])[0]!;
}

function measure(element: ReactElement<ElementProps>, width: number) {
  element.props.onLayout!({
    nativeEvent: { layout: { width } },
  } as LayoutChangeEvent);
}

beforeEach(() => {
  states.length = 0;
});

test("long unit/RIC labels move intact below the timestamp without shrinking", () => {
  const rics = [790241];
  const units = new Map([[790241, "Gasilska brigada Ljubljana"]]);
  const header = render(rics, units);
  const children = header.props.children as [
    ReactElement<ElementProps>,
    ReactElement<ElementProps>,
    ReactElement<ElementProps>[],
  ];
  const date = children[0]!;
  const label = (
    children[2][0]!.props.children as ReactElement<ElementProps>[]
  )[0]!;
  measure(header, 328);
  measure(date, 132);
  measure(label, 270);
  const next = render(rics, units).props
    .children as ReactElement<ElementProps>[];
  expect(next[0]!.type).toBe("Typography");
  expect(next[1]!.props.style?.width).toBe("100%");
  expect((label.props.children as string[])[0]).toBe(
    "Gasilska\u00a0brigada\u00a0Ljubljana\u00a0(0790241)",
  );
  expect(label.props.style?.flexShrink).toBe(0);
});

test("short comma-separated RICs fill the space before the date and then wrap", () => {
  const rics = [790193, 790113, 790241];
  const header = render(rics);
  const children = header.props.children as [
    ReactElement<ElementProps>,
    ReactElement<ElementProps>,
    ReactElement<ElementProps>[],
  ];
  measure(header, 328);
  measure(children[0]!, 132);
  for (const child of children[2]) {
    measure((child.props.children as ReactElement<ElementProps>[])[0]!, 70);
  }
  const next = render(rics).props.children as [
    boolean,
    boolean,
    ReactElement<ElementProps>[],
  ];
  const first = next[2][0]!.props.children as [
    ReactElement<ElementProps>,
    boolean,
    boolean,
  ];
  const second = next[2][1]!.props.children as ReactElement<ElementProps>[];
  const third = next[2][2]!.props.children as ReactElement<ElementProps>[];
  expect(first[0]!.props.children).toEqual(["0790193", ","]);
  expect(first[1]).toBe(false);
  expect(second[1]!.type).toBe("Typography");
  expect(second[2]!.props.style?.width).toBe("100%");
  expect(third[0]!.props.children).toEqual(["0790241", false]);
});
