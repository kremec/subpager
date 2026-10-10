import type { LegendListRef } from "@legendapp/list/react-native";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
  DependencyList,
  EffectCallback,
  ReactElement,
  RefObject,
} from "react";

const react = await import("react");
const refs: RefObject<LegendListRef | boolean | null>[] = [];
const dependencies: (DependencyList | undefined)[] = [];
const effects: EffectCallback[] = [];
const cleanups: (() => void)[] = [];
const offsets: number[] = [];
let hookIndex = 0;
let syncVersion = 0;

mock.module("react", () => ({
  ...react,
  useRef: (initial: null | boolean) => {
    const index = hookIndex++;
    refs[index] ??= { current: initial };
    return refs[index];
  },
  useEffect: (effect: EffectCallback, next: DependencyList) => {
    const index = hookIndex++;
    const previous = dependencies[index];
    if (!previous || next.some((value, i) => !Object.is(value, previous[i])))
      effects.push(effect);
    dependencies[index] = next;
  },
}));
mock.module("@/pager/use-message-history", () => ({
  useMessageHistory: () => ({ messages: [], loading: false, syncVersion }),
}));
mock.module("@/components/ui/screen", () => ({ Screen: "Screen" }));
mock.module("@/components/ui/typography", () => ({ Typography: "Typography" }));
mock.module("@/screens/history/history-header", () => ({
  HistoryHeader: "HistoryHeader",
}));
mock.module("@/screens/history/message-list", () => ({
  MessageList: "MessageList",
}));

const { HistoryScreen } = await import("@/screens/history/history-screen");

function render() {
  hookIndex = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise lifecycle effects without a native renderer.
  const screen = HistoryScreen({}) as ReactElement<{
    children: ReactElement<{ onScrollBeginDrag: () => void }>[];
  }>;
  refs[0]!.current = {
    scrollToOffset: (options: { offset: number }) => {
      offsets.push(options.offset);
    },
  } as LegendListRef;
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return screen.props.children.find((child) => child?.type === "MessageList")!
    .props;
}

beforeEach(() => {
  refs.length = 0;
  dependencies.length = 0;
  effects.length = 0;
  offsets.length = 0;
  syncVersion = 0;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("fresh launches start at the top through initial catch-up, while later foreground syncs preserve position", () => {
  render();
  expect(offsets).toEqual([0]);
  syncVersion++;
  render();
  expect(offsets).toEqual([0, 0]);
  render();
  expect(offsets).toEqual([0, 0]);

  syncVersion++;
  render();
  expect(offsets).toEqual([0, 0]);
});

test("scrolling before initial catch-up preserves position through subsequent syncs", () => {
  render().onScrollBeginDrag();
  syncVersion++;
  render();
  expect(offsets).toEqual([0]);

  syncVersion++;
  render();
  expect(offsets).toEqual([0]);
});
