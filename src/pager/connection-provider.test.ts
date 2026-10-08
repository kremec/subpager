import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { DependencyList, EffectCallback, ReactElement } from "react";

interface DeviceAccess {
  uid: string;
  approved: boolean;
}
type State = DeviceAccess | string | number | boolean | null;
interface AccessContext {
  uid: string | null;
  approved: boolean;
  ready: boolean;
  error: string | null;
  hasAccess: (uid: string) => boolean;
}

const react = await import("react");
const states: State[] = [];
const refs: { current: string | boolean | null }[] = [];
const effects: EffectCallback[] = [];
const layouts: { effect: EffectCallback; dependencies?: DependencyList }[] = [];
const previousLayouts: (DependencyList | undefined)[] = [];
let stateIndex = 0;
let refIndex = 0;
let cleanup: (() => void) | undefined;
let token: string | null;
let loading = false;
let backendAuthenticated = true;
let currentDevice: DeviceAccess | null | undefined;
let queryFailure: Error | undefined;
let update: (() => void) | undefined;
let dismissed = 0;
let signIns = 0;
let registrations = 0;
const errors: string[] = [];
let cachedUid: string | null = null;
let cacheFailure = false;

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
  useRef: <T extends string | boolean | null>(initial: T) => {
    const index = refIndex++;
    refs[index] ??= { current: initial };
    return refs[index] as { current: T };
  },
  useEffect: (effect: EffectCallback) => effects.push(effect),
  useLayoutEffect: (effect: EffectCallback, dependencies?: DependencyList) =>
    layouts.push({ effect, dependencies }),
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
mock.module("expo-notifications", () => ({
  dismissAllNotificationsAsync: async () => {
    dismissed++;
  },
  clearLastNotificationResponseAsync: async () => {},
}));
mock.module("@/pager/convex", () => ({
  getConvex: () => ({
    watchQuery: () => ({
      localQueryResult: () => {
        if (queryFailure) throw queryFailure;
        return currentDevice;
      },
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
mock.module("@/pager/database", () => ({
  initializeDatabase: () => {
    if (cacheFailure) throw new Error("Cache unavailable");
  },
  cachedApproval: (uid: string) => uid === cachedUid,
  cacheApproval: (uid: string, approved: boolean) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    cachedUid = approved ? uid : null;
  },
}));
mock.module("@/components/ui/toast", () => ({
  showErrorToast: (message: string) => errors.push(message),
}));

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
  layouts.forEach((layout, index) => {
    const previous = previousLayouts[index];
    if (
      !layout.dependencies ||
      !previous ||
      layout.dependencies.some(
        (value, position) => !Object.is(value, previous[position]),
      )
    )
      layout.effect();
    previousLayouts[index] = layout.dependencies;
  });
  return element.props.value;
}
async function initialize() {
  render();
  effects[0]!();
  const result = effects[1]!();
  if (typeof result === "function") cleanup = result;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return render();
}

beforeEach(() => {
  states.length = 0;
  refs.length = 0;
  previousLayouts.length = 0;
  token = identity("test-device");
  loading = false;
  backendAuthenticated = true;
  currentDevice = undefined;
  queryFailure = undefined;
  dismissed = 0;
  signIns = 0;
  registrations = 0;
  errors.length = 0;
  cachedUid = null;
  cacheFailure = false;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("auth token loading waits before sign-in or device registration", async () => {
  loading = true;
  token = null;
  const access = await initialize();
  expect(access.ready).toBe(false);
  expect(signIns).toBe(0);
  expect(registrations).toBe(0);
});

test("an identity without cached approval requires live approval", async () => {
  const access = await initialize();
  expect(access.ready).toBe(true);
  expect(access.uid).toBe("test-device");
  expect(access.approved).toBe(false);
  currentDevice = { uid: "test-device", approved: true };
  update?.();
  expect(render().approved).toBe(true);
  expect(render().hasAccess("test-device")).toBe(true);
});

test("offline access requires the same previously approved identity", async () => {
  backendAuthenticated = false;
  cachedUid = "test-device";
  const access = await initialize();
  expect(access.approved).toBe(true);
  expect(access.hasAccess("test-device")).toBe(true);
  expect(registrations).toBe(0);
  token = identity("new-device");
  render();
  expect(render().approved).toBe(false);
  expect(render().hasAccess("test-device")).toBe(false);
});

test("backend authentication gates device registration and approval", async () => {
  backendAuthenticated = false;
  const access = await initialize();
  expect(access.approved).toBe(false);
  expect(update).toBeUndefined();
  expect(registrations).toBe(0);
});

test("null or another identity cannot grant or revoke approval", async () => {
  currentDevice = { uid: "test-device", approved: true };
  await initialize();
  currentDevice = null;
  update?.();
  currentDevice = { uid: "other-device", approved: false };
  update?.();
  expect(render().hasAccess("test-device")).toBe(true);
  expect(dismissed).toBe(0);
});

test("revocation immediately blocks history and dismisses notifications", async () => {
  currentDevice = { uid: "test-device", approved: true };
  await initialize();
  currentDevice = { uid: "test-device", approved: false };
  update?.();
  const access = render();
  expect(access.approved).toBe(false);
  expect(access.hasAccess("test-device")).toBe(false);
  expect(dismissed).toBe(1);
  expect(cachedUid).toBeNull();
});

test("identity changes and cleanup reject late approval callbacks", async () => {
  currentDevice = { uid: "test-device", approved: true };
  await initialize();
  const lateUpdate = update;
  token = identity("new-device");
  const access = render();
  lateUpdate?.();
  expect(access.approved).toBe(false);
  expect(access.hasAccess("test-device")).toBe(false);
  cleanup?.();
  cleanup = undefined;
  lateUpdate?.();
  expect(render().approved).toBe(false);
});

test("approval query failures become toasts while history remains blocked", async () => {
  queryFailure = new Error("Approval lookup failed");
  const access = await initialize();
  effects[2]!();
  expect(access.approved).toBe(false);
  expect(errors).toEqual(["Approval lookup failed"]);
});

test("unreadable persisted identities show a recoverable error instead of waiting forever", async () => {
  token = "invalid";
  const access = await initialize();
  expect(access.ready).toBe(true);
  expect(access.uid).toBeNull();
  expect(access.approved).toBe(false);
});

test("unavailable offline storage does not block live approved access", async () => {
  cacheFailure = true;
  currentDevice = { uid: "test-device", approved: true };
  await initialize();
  expect(render().approved).toBe(true);
  expect(render().hasAccess("test-device")).toBe(true);
  expect(errors).toContain("Could not read saved device approval.");
  expect(errors).toContain("Could not save device approval.");
});
