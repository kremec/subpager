import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EffectCallback, ReactElement } from "react";

interface SavedAccess {
  uid: string;
  approved: boolean;
}
type State = SavedAccess | string | number | boolean | null;
interface AccessContext {
  uid: string | null;
  approved: boolean;
  ready: boolean;
  hasAccess: (uid: string) => boolean;
}

const react = await import("react");
const states: State[] = [];
const refs: { current: string | boolean | Promise<void> | null }[] = [];
const effects: EffectCallback[] = [];
const layouts: EffectCallback[] = [];
let stateIndex = 0;
let refIndex = 0;
let cleanup: (() => void) | undefined;
let token: string | null;
let loading = false;
let backendAuthenticated = true;
let saved: SavedAccess | null;
let currentDevice: SavedAccess | null | undefined;
let update: (() => void) | undefined;
let cleared = 0;
let dismissed = 0;
let signIns = 0;
let registrations = 0;
let holdApprovalWrite: (() => Promise<void>) | undefined;
const persisted: SavedAccess[] = [];

mock.module("react", () => ({
  ...react,
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
  useRef: <T extends string | boolean | Promise<void> | null>(initial: T) => {
    const index = refIndex++;
    refs[index] ??= { current: initial };
    return refs[index] as { current: T };
  },
  useEffect: (effect: EffectCallback) => effects.push(effect),
  useLayoutEffect: (effect: EffectCallback) => layouts.push(effect),
  useMemo: <T>(callback: () => T) => callback(),
  useCallback: <T>(callback: T) => callback,
}));
mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
mock.module("@convex-dev/auth/react", () => ({
  useConvexAuth: () => ({
    isLoading: loading,
    isAuthenticated: token !== null,
  }),
  useAuthToken: () => token,
  useAuthActions: () => ({
    signIn: async () => {
      signIns++;
    },
  }),
}));
mock.module("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: backendAuthenticated }),
}));
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => saved && JSON.stringify(saved),
  setItemAsync: async (_key: string, value: string) => {
    const next = JSON.parse(value) as SavedAccess;
    if (next.approved) await holdApprovalWrite?.();
    saved = next;
    persisted.push(saved);
  },
}));
mock.module("expo-notifications", () => ({
  dismissAllNotificationsAsync: async () => {
    dismissed++;
  },
  clearLastNotificationResponseAsync: async () => {},
}));
mock.module("@/pager/database", () => ({
  initializeDatabase: () => {},
  clearMessages: () => {
    cleared++;
  },
}));
mock.module("@/pager/convex", () => ({
  getConvex: () => ({
    url: "https://test.convex.cloud",
    watchQuery: () => ({
      localQueryResult: () => currentDevice,
      onUpdate: (callback: () => void) => {
        update = callback;
        return () => {
          update = undefined;
        };
      },
    }),
    mutation: async () => {
      registrations++;
    },
  }),
}));
mock.module("@/components/ui/toast", () => ({ showErrorToast: () => {} }));

const { ConnectionProvider } = await import("@/pager/connection-provider");

function identity(uid: string) {
  return `header.${btoa(JSON.stringify({ sub: `${uid}|session` }))}.signature`;
}
function render() {
  stateIndex = 0;
  refIndex = 0;
  effects.length = 0;
  layouts.length = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise captured effects without a native renderer.
  const element = ConnectionProvider({ children: null }) as ReactElement<{
    value: AccessContext;
  }>;
  for (const effect of layouts) effect();
  return element.props.value;
}
async function initialize() {
  render();
  effects[0]!();
  const result = effects[1]!();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  render();
  const watchCleanup = effects[2]!();
  cleanup = () => {
    if (typeof result === "function") result();
    if (typeof watchCleanup === "function") watchCleanup();
  };
  return render();
}

beforeEach(() => {
  states.length = 0;
  refs.length = 0;
  token = identity("approved-device");
  loading = false;
  backendAuthenticated = true;
  saved = { uid: "approved-device", approved: true };
  currentDevice = undefined;
  cleared = 0;
  dismissed = 0;
  signIns = 0;
  registrations = 0;
  holdApprovalWrite = undefined;
  persisted.length = 0;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("auth storage loading does not erase offline history", async () => {
  loading = true;
  token = null;
  const access = await initialize();
  expect(access.ready).toBe(false);
  expect(cleared).toBe(0);
  expect(signIns).toBe(0);
});

test("cached approval opens offline history only for the same identity", async () => {
  backendAuthenticated = false;
  const access = await initialize();
  expect(access.ready).toBe(true);
  expect(access.approved).toBe(true);
  expect(access.hasAccess("approved-device")).toBe(true);
  expect(cleared).toBe(0);
  expect(update).toBeUndefined();
  expect(registrations).toBe(0);
});

test("server authentication starts cloud registration without blocking cached access", async () => {
  backendAuthenticated = false;
  await initialize();
  backendAuthenticated = true;
  expect(render().approved).toBe(true);
  const stop = effects[2]!();
  expect(registrations).toBe(1);
  expect(cleared).toBe(0);
  if (typeof stop === "function") stop();
});

test("null or another identity from the server is not evidence of revocation", async () => {
  await initialize();
  currentDevice = null;
  update?.();
  currentDevice = { uid: "other-device", approved: false };
  update?.();
  expect(render().hasAccess("approved-device")).toBe(true);
  expect(render().approved).toBe(true);
  expect(cleared).toBe(0);
  expect(dismissed).toBe(0);
  expect(persisted).toEqual([]);
});

test("new anonymous identities clear cached history and require approval", async () => {
  token = identity("new-device");
  const access = await initialize();
  expect(access.approved).toBe(false);
  expect(access.hasAccess("approved-device")).toBe(false);
  expect(cleared).toBe(1);
});

test("revocation blocks access and erases history and pending notifications", async () => {
  await initialize();
  currentDevice = { uid: "approved-device", approved: false };
  update?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const access = render();
  expect(access.approved).toBe(false);
  expect(access.hasAccess("approved-device")).toBe(false);
  expect(cleared).toBe(1);
  expect(dismissed).toBe(1);
  expect(persisted).toEqual([{ uid: "approved-device", approved: false }]);
});

test("identity changes and cleanup reject late approval callbacks", async () => {
  await initialize();
  const lateUpdate = update;
  token = identity("new-device");
  currentDevice = { uid: "approved-device", approved: true };
  const access = render();
  lateUpdate?.();
  expect(access.hasAccess("approved-device")).toBe(false);
  expect(persisted).toEqual([]);
  cleanup?.();
  cleanup = undefined;
  lateUpdate?.();
  expect(persisted).toEqual([]);
});

test("unreadable persisted identities show a recoverable error instead of waiting forever", async () => {
  token = "invalid";
  const access = await initialize();
  expect(access.ready).toBe(true);
  expect(access.uid).toBeNull();
  expect(access.approved).toBe(false);
});

test("a slow approval write cannot overwrite a later persisted revocation", async () => {
  await initialize();
  let finish = () => {};
  holdApprovalWrite = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  currentDevice = { uid: "approved-device", approved: true };
  update?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  currentDevice = { uid: "approved-device", approved: false };
  update?.();
  expect(render().hasAccess("approved-device")).toBe(false);
  expect(persisted).toEqual([]);
  finish();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(persisted.map((access) => access.approved)).toEqual([true, false]);
  expect(saved?.approved).toBe(false);
});
