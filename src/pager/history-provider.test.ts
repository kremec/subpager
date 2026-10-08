import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EffectCallback, SetStateAction } from "react";

import type { PagerMessage, RicUnit } from "@/pager/types";

const react = await import("react");
const effects: EffectCallback[] = [];
let cleanup: (() => void) | undefined;
let foreground: ((state: string) => void) | undefined;
let allowed = true;
let ready = true;
let authenticated = true;
let messagesAttached = 0;
let unitsAttached = 0;
let messagesDetached = 0;
let unitsDetached = 0;
let onMessages: ((messages: PagerMessage[]) => void) | undefined;
let onUnits: ((units: RicUnit[]) => void) | undefined;
let messagesError: ((error: Error) => void) | undefined;
let unitsError: ((error: Error) => void) | undefined;
const savedMessages: PagerMessage[][] = [];
const savedUnits: RicUnit[][] = [];
let cachedReads = 0;

mock.module("react", () => ({
  ...react,
  useEffect: (effect: EffectCallback) => effects.push(effect),
  useState: <T>(value: T) => [value, (_next: SetStateAction<T>) => {}],
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
mock.module("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: authenticated }),
}));
mock.module("@/pager/connection-provider", () => ({
  useConnection: () => ({
    connection: { uid: "test-device" },
    hasAccess: () => allowed,
    ready,
  }),
}));
mock.module("@/pager/database", () => ({
  cachedMessages: () => {
    cachedReads++;
    return [];
  },
  cachedRicUnits: () => new Map(),
  cacheMessages: (messages: PagerMessage[]) => savedMessages.push(messages),
  cacheRicUnits: (units: RicUnit[]) => savedUnits.push(units),
  subscribeToMessages: () => () => {},
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
mock.module("@/components/ui/toast", () => ({ showErrorToast: () => {} }));

const { HistoryProvider } = await import("@/pager/history-provider");

beforeEach(() => {
  effects.length = 0;
  savedMessages.length = 0;
  savedUnits.length = 0;
  allowed = true;
  ready = true;
  authenticated = true;
  cachedReads = 0;
  messagesAttached = 0;
  unitsAttached = 0;
  messagesDetached = 0;
  unitsDetached = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Run captured effects without a native renderer.
  HistoryProvider({ children: null });
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("foreground keeps healthy listeners attached", () => {
  foreground?.("active");
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect([messagesDetached, unitsDetached]).toEqual([0, 0]);
});

test("pending server authentication reads offline history and delays cloud subscriptions", () => {
  cleanup?.();
  effects.length = 0;
  authenticated = false;
  cachedReads = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Simulate an offline cached connection.
  HistoryProvider({ children: null });
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  expect(cachedReads).toBe(1);
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect([messagesDetached, unitsDetached]).toEqual([1, 1]);
});

test("foreground retries only the failed listener and resumes cache updates", () => {
  messagesError?.(new Error("Permission denied"));
  foreground?.("background");
  expect(messagesAttached).toBe(1);
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 1]);
  expect([messagesDetached, unitsDetached]).toEqual([1, 0]);
  onMessages?.([]);
  expect(savedMessages).toEqual([[]]);

  unitsError?.(new Error("Permission denied"));
  foreground?.("active");
  onUnits?.([{ ric: 123, unitName: "Recovered unit" }]);
  expect(savedUnits).toEqual([[{ ric: 123, unitName: "Recovered unit" }]]);
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
});

test("persistent listener failures retry once per foreground event", () => {
  messagesError?.(new Error("Permission denied"));
  foreground?.("active");
  messagesError?.(new Error("Permission denied"));
  expect(messagesAttached).toBe(2);
  foreground?.("active");
  expect(messagesAttached).toBe(3);
});

test("errors during access retry remain recoverable when access returns", () => {
  allowed = false;
  messagesError?.(new Error("Permission denied"));
  unitsError?.(new Error("Permission denied"));
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  allowed = true;
  foreground?.("active");
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
});

test("connection retry stops history and reattaches after initialization", () => {
  cleanup?.();
  effects.length = 0;
  ready = false;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Simulate a connection-state render.
  HistoryProvider({ children: null });
  const waitingCleanup = effects[0]!();
  onMessages?.([]);
  onUnits?.([]);
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect(savedMessages).toEqual([]);
  expect(savedUnits).toEqual([]);
  if (typeof waitingCleanup === "function") waitingCleanup();

  effects.length = 0;
  ready = true;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Simulate a connection-state render.
  HistoryProvider({ children: null });
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  expect([messagesAttached, unitsAttached]).toEqual([2, 2]);
  onMessages?.([]);
  onUnits?.([]);
  expect(savedMessages).toEqual([[]]);
  expect(savedUnits).toEqual([[]]);
});

test("revocation and cleanup block late callbacks and further retries", () => {
  messagesError?.(new Error("Permission denied"));
  allowed = false;
  foreground?.("active");
  onMessages?.([]);
  onUnits?.([]);
  expect([messagesAttached, unitsAttached]).toEqual([1, 1]);
  expect(savedMessages).toEqual([]);
  expect(savedUnits).toEqual([]);

  cleanup?.();
  cleanup = undefined;
  allowed = true;
  onMessages?.([]);
  onUnits?.([]);
  expect(foreground).toBeUndefined();
  expect([messagesDetached, unitsDetached]).toEqual([1, 1]);
  expect(savedMessages).toEqual([]);
  expect(savedUnits).toEqual([]);
});
