import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EffectCallback, ReactElement } from "react";

import type {
  CachedSync,
  MessageChanges,
  PagerMessage,
  RicUnit,
} from "@/pager/types";

interface HistoryValue {
  messages: PagerMessage[];
  unitNames: ReadonlyMap<number, string>;
  loading: boolean;
  syncVersion: number;
}
type State =
  | PagerMessage[]
  | ReadonlyMap<number, string>
  | boolean
  | number
  | string
  | undefined;
const react = await import("react");
const effects: EffectCallback[] = [];
const states: State[] = [];
let stateIndex = 0;
let cleanup: (() => void) | undefined;
let foreground: ((state: string) => void) | undefined;
let allowed = true;
let uid = "test-device";
let saved: { messages: PagerMessage[]; units: RicUnit[] } | null = null;
let cacheFailure = false;
const savedMessages: PagerMessage[][] = [];
const savedUnits: RicUnit[][] = [];
let messagesAttached = 0;
let unitsAttached = 0;
let messagesDetached = 0;
let unitsDetached = 0;
let onMessages: ((messages: PagerMessage[]) => void) | undefined;
let onUnits: ((units: RicUnit[]) => void) | undefined;
let messagesError: ((error: Error) => void) | undefined;
let unitsError: ((error: Error) => void) | undefined;
const errors: string[] = [];
const queries: CachedSync[] = [];
let batchCursor = { seconds: 100, nanoseconds: 1 };

mock.module("react", () => ({
  ...react,
  useEffect: (effect: EffectCallback) => effects.push(effect),
  useState: <T extends State>(initial?: T) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = initial;
    return [
      states[index] as T,
      (next: T | ((value: T) => T)) => {
        states[index] =
          typeof next === "function" ? next(states[index] as T) : next;
      },
    ];
  },
  useCallback: <T>(callback: T) => callback,
}));
mock.module("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      foreground = listener;
      return { remove: () => (foreground = undefined) };
    },
  },
}));
mock.module("@/pager/connection-provider", () => ({
  useConnection: () => ({
    connection: allowed ? { uid } : null,
    hasAccess: (value: string) => allowed && value === uid,
  }),
}));
mock.module("@/pager/database", () => ({
  cachedHistory: () => {
    if (cacheFailure) throw new Error("Cache unavailable");
    return saved;
  },
  cachedSync: () => ({
    initialized: false,
    cursor: { seconds: 0, nanoseconds: 0 },
    ricRevision: null,
  }),
  cacheMessages: (_uid: string, messages: PagerMessage[]) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    savedMessages.push(messages);
    return true;
  },
  cacheRicUnits: (_uid: string, units: RicUnit[]) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    savedUnits.push(units);
    return true;
  },
}));
mock.module("@/pager/firebase", () => ({
  watchMessages: (
    sync: CachedSync,
    success: (changes: MessageChanges) => boolean,
    failure: (error: Error) => void,
  ) => {
    queries.push(sync);
    messagesAttached++;
    onMessages = (messages) =>
      success({ messages, removedIds: [], cursor: batchCursor, reset: false });
    messagesError = failure;
    return () => messagesDetached++;
  },
  watchRicUnits: (
    _savedRevision: () => string | null,
    success: (units: RicUnit[], revision: string) => void,
    failure: (error: Error) => void,
  ) => {
    unitsAttached++;
    onUnits = (units) => success(units, "r1");
    unitsError = failure;
    return () => unitsDetached++;
  },
}));
mock.module("@/components/ui/toast", () => ({
  showErrorToast: (message: string) => errors.push(message),
}));

const { HistoryProvider } = await import("@/pager/history-provider");
function render() {
  stateIndex = 0;
  effects.length = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise captured effects without a native renderer.
  const element = HistoryProvider({ children: null }) as ReactElement<{
    value: HistoryValue;
  }>;
  return element.props.value;
}
const message: PagerMessage = {
  id: "native-message-id",
  receivedAt: "2026-10-08T10:00:00Z",
  ric: 123,
  function: 0,
  type: "alpha",
  content: "GORI V ŠOLI GOLO",
  duplicateOf: null,
};

beforeEach(() => {
  states.length = 0;
  allowed = true;
  uid = "test-device";
  saved = null;
  cacheFailure = false;
  savedMessages.length = 0;
  savedUnits.length = 0;
  messagesAttached = 0;
  unitsAttached = 0;
  messagesDetached = 0;
  unitsDetached = 0;
  errors.length = 0;
  queries.length = 0;
  batchCursor = { seconds: 100, nanoseconds: 1 };
  render();
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("live query updates replace messages and include later locations", () => {
  onMessages?.([message]);
  expect(render().messages).toEqual([message]);
  onMessages?.([{ ...message, location: "ŠOLI GOLO" }]);
  onUnits?.([{ ric: 123, unitName: "Golo" }]);
  const history = render();
  expect(history.messages[0]?.location).toBe("ŠOLI GOLO");
  expect(history.unitNames.get(123)).toBe("Golo");
  expect(history.loading).toBe(false);
  expect(savedMessages.at(-1)?.[0]?.location).toBe("ŠOLI GOLO");
});

test("saved history remains visible until confirmed cloud data arrives", () => {
  cleanup?.();
  cleanup = undefined;
  saved = { messages: [message], units: [{ ric: 123, unitName: "Golo" }] };
  render();
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  expect(render().messages).toEqual([message]);
  expect(render().unitNames.get(123)).toBe("Golo");
  expect(render().loading).toBe(false);
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
});

test("unapproved devices do not subscribe to history", () => {
  cleanup?.();
  cleanup = undefined;
  allowed = false;
  render();
  effects[0]!();
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect(render().messages).toEqual([]);
});

test("foreground keeps healthy live subscriptions attached", () => {
  foreground?.("active");
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect([messagesDetached, unitsDetached]).toEqual([0, 0]);
});

test("sync version changes only for the first message batch after subscribing", () => {
  expect(render().syncVersion).toBe(0);
  onMessages?.([message]);
  expect(render().syncVersion).toBe(1);
  onMessages?.([{ ...message, id: "live-message" }]);
  expect(render().syncVersion).toBe(1);

  const lateMessages = onMessages;
  foreground?.("background");
  lateMessages?.([message]);
  expect(render().syncVersion).toBe(1);
  foreground?.("active");
  onMessages?.([]);
  expect(render().syncVersion).toBe(2);
  onMessages?.([message]);
  expect(render().syncVersion).toBe(2);
});

test("query failures show toasts and retry only failed subscriptions on foreground", () => {
  messagesError?.(new Error("History unavailable"));
  expect(render().loading).toBe(false);
  expect(errors).toEqual(["History unavailable"]);
  foreground?.("background");
  expect(messagesAttached).toBe(1);
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
  onMessages?.([message]);
  expect(render().messages).toEqual([message]);

  unitsError?.(new Error("Units unavailable"));
  foreground?.("active");
  onUnits?.([{ ric: 123, unitName: "Recovered unit" }]);
  expect(render().unitNames.get(123)).toBe("Recovered unit");
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 3]);
});

test("revocation hides history immediately and cleanup blocks late callbacks", () => {
  onMessages?.([message]);
  onUnits?.([{ ric: 123, unitName: "Golo" }]);
  allowed = false;
  expect(render().messages).toEqual([]);
  expect(render().unitNames.size).toBe(0);
  foreground?.("active");
  cleanup?.();
  cleanup = undefined;
  render();
  effects[0]!();
  allowed = true;
  onMessages?.([message]);
  onUnits?.([{ ric: 123, unitName: "Late unit" }]);
  expect(render().messages).toEqual([]);
  expect(render().unitNames.size).toBe(0);
  expect(foreground).toBeUndefined();
  expect([messagesDetached, unitsDetached]).toEqual([1, 1]);
  expect(savedMessages).toEqual([[message]]);
  expect(savedUnits).toEqual([[{ ric: 123, unitName: "Golo" }]]);
});

test("cache failures do not prevent live query updates", () => {
  cleanup?.();
  cacheFailure = true;
  render();
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  onMessages?.([message]);
  expect(render().messages).toEqual([message]);
  expect(render().loading).toBe(false);
  expect(errors).toContain("Could not read saved history.");
  expect(errors).toContain("Could not save message history.");
});

test("approved identity changes hide previous history before the replacement effect runs", () => {
  onMessages?.([message]);
  onUnits?.([{ ric: 123, unitName: "Previous unit" }]);
  expect(render().messages).toEqual([message]);
  const previousMessages = onMessages;
  const previousUnits = onUnits;
  uid = "replacement-device";
  const replacement = { ...message, id: "replacement-message-id" };
  saved = {
    messages: [replacement],
    units: [{ ric: 123, unitName: "Replacement unit" }],
  };
  const beforeEffect = render();
  expect(beforeEffect.messages).toEqual([]);
  expect(beforeEffect.unitNames.size).toBe(0);
  previousMessages?.([message]);
  previousUnits?.([{ ric: 123, unitName: "Late previous unit" }]);
  expect(savedMessages).toEqual([[message]]);
  expect(savedUnits).toEqual([[{ ric: 123, unitName: "Previous unit" }]]);
  cleanup?.();
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  const afterEffect = render();
  expect(afterEffect.messages).toEqual([replacement]);
  expect(afterEffect.unitNames.get(123)).toBe("Replacement unit");
});

test("background pauses history and catalogs, then resumes from the last saved cursor", () => {
  onMessages?.([message]);
  const lateMessages = onMessages;
  const lateUnits = onUnits;
  foreground?.("background");
  expect([messagesDetached, unitsDetached]).toEqual([1, 1]);
  lateMessages?.([{ ...message, location: "Late callback" }]);
  lateUnits?.([{ ric: 123, unitName: "Late catalog" }]);
  expect(render().messages[0]?.location).toBeUndefined();
  foreground?.("active");
  expect(queries.at(-1)?.cursor).toEqual(batchCursor);
  expect(queries.at(-1)?.initialized).toBe(true);
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
});

test("cache failure leaves the resume cursor unchanged while keeping live history visible", () => {
  onMessages?.([message]);
  const savedCursor = batchCursor;
  cacheFailure = true;
  batchCursor = { seconds: 200, nanoseconds: 2 };
  onMessages?.([{ ...message, location: "Golo" }]);
  expect(render().messages[0]?.location).toBe("Golo");
  foreground?.("background");
  foreground?.("active");
  expect(queries.at(-1)?.cursor).toEqual(savedCursor);
});
