import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EffectCallback, ReactElement } from "react";

import type { PagerMessage, RicUnit } from "@/pager/types";

interface HistoryValue {
  messages: PagerMessage[];
  unitNames: ReadonlyMap<number, string>;
  loading: boolean;
}
type State = PagerMessage[] | ReadonlyMap<number, string> | boolean | number;
const react = await import("react");
const effects: EffectCallback[] = [];
const states: State[] = [];
let stateIndex = 0;
let cleanup: (() => void) | undefined;
let foreground: ((state: string) => void) | undefined;
let allowed = true;
let authenticated = true;
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

mock.module("react", () => ({
  ...react,
  useEffect: (effect: EffectCallback) => effects.push(effect),
  useState: <T extends State>(initial: T) => {
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
    addEventListener: (_event: string, listener: (state: string) => void) => {
      foreground = listener;
      return { remove: () => (foreground = undefined) };
    },
  },
}));
mock.module("@/pager/connection-provider", () => ({
  useConnection: () => ({
    connection: allowed ? { uid: "test-device" } : null,
    hasAccess: () => allowed,
  }),
}));
mock.module("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: authenticated }),
}));
mock.module("@/pager/database", () => ({
  cachedHistory: () => {
    if (cacheFailure) throw new Error("Cache unavailable");
    return saved;
  },
  cacheMessages: (_uid: string, messages: PagerMessage[]) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    savedMessages.push(messages);
  },
  cacheRicUnits: (_uid: string, units: RicUnit[]) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    savedUnits.push(units);
  },
}));
mock.module("@/pager/convex", () => ({
  watchMessages: (
    success: (messages: PagerMessage[]) => void,
    failure: (error: Error) => void,
  ) => {
    messagesAttached++;
    onMessages = success;
    messagesError = failure;
    return () => messagesDetached++;
  },
  watchRicUnits: (
    success: (units: RicUnit[]) => void,
    failure: (error: Error) => void,
  ) => {
    unitsAttached++;
    onUnits = success;
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
  authenticated = true;
  saved = null;
  cacheFailure = false;
  savedMessages.length = 0;
  savedUnits.length = 0;
  messagesAttached = 0;
  unitsAttached = 0;
  messagesDetached = 0;
  unitsDetached = 0;
  errors.length = 0;
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

test("offline approved devices read saved history without cloud subscriptions", () => {
  cleanup?.();
  cleanup = undefined;
  authenticated = false;
  saved = { messages: [message], units: [{ ric: 123, unitName: "Golo" }] };
  render();
  effects[0]!();
  expect(render().messages).toEqual([message]);
  expect(render().unitNames.get(123)).toBe("Golo");
  expect(render().loading).toBe(false);
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
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

test("query failures show toasts and retry only failed subscriptions on foreground", () => {
  messagesError?.(new Error("History unavailable"));
  expect(render().loading).toBe(false);
  expect(errors).toEqual(["History unavailable"]);
  foreground?.("background");
  expect(messagesAttached).toBe(1);
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 1]);
  onMessages?.([message]);
  expect(render().messages).toEqual([message]);

  unitsError?.(new Error("Units unavailable"));
  foreground?.("active");
  onUnits?.([{ ric: 123, unitName: "Recovered unit" }]);
  expect(render().unitNames.get(123)).toBe("Recovered unit");
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
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
