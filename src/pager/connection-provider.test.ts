import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EffectCallback, ReactElement } from "react";

interface Access {
  uid: string;
  approved: boolean;
}
interface ConnectionValue {
  uid: string | null;
  ready: boolean;
  approved: boolean;
  connection: { uid: string } | null;
  error: string | null;
  hasAccess: (uid: string) => boolean;
}
interface MemberSnapshot {
  metadata: { fromCache: boolean };
  data: () => { approved: boolean } | undefined;
}
type State = Access | string | boolean | number | null;
interface TestAuth {
  currentUser: { uid: string } | null;
  authStateReady: () => Promise<void>;
}
const react = await import("react");
const effects: EffectCallback[] = [];
const states: State[] = [];
const refs: { current: TestAuth | string | null }[] = [];
let stateIndex = 0;
let refIndex = 0;
let cleanup: (() => void) | undefined;
let authListener: ((user: { uid: string } | null) => void) | undefined;
let memberListener: ((snapshot: MemberSnapshot) => void) | undefined;
let memberError: ((error: Error) => void) | undefined;
let authReady: (() => Promise<void>) | undefined;
let cachedUid: string | null = null;
let cacheFailure = false;
let signInFailure = false;
let memberSubscriptions = 0;
let dismissed = 0;
let cleared = 0;
let signIns = 0;
const errors: string[] = [];
const cacheWrites: [string, boolean][] = [];
const auth: TestAuth = {
  currentUser: { uid: "firebase-device" },
  authStateReady: async () => {
    await authReady?.();
  },
};

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
  useRef: <T extends TestAuth | string | null>(initial: T) => {
    const index = refIndex++;
    refs[index] ??= { current: initial };
    return refs[index];
  },
  useMemo: <T>(factory: () => T) => factory(),
  useCallback: <T>(callback: T) => callback,
}));
mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
mock.module("firebase/auth", () => ({
  onAuthStateChanged: (_auth: TestAuth, listener: typeof authListener) => {
    authListener = listener;
    listener?.(auth.currentUser);
    return () => {
      authListener = undefined;
    };
  },
  signInAnonymously: async () => {
    signIns++;
    if (signInFailure) throw new Error("Cannot sign in");
    auth.currentUser = { uid: "new-firebase-device" };
  },
}));
mock.module("firebase/firestore", () => ({
  doc: (_database: object, collection: string, uid: string) => ({
    collection,
    uid,
  }),
  onSnapshot: (
    _doc: object,
    _options: object,
    success: typeof memberListener,
    failure: typeof memberError,
  ) => {
    memberSubscriptions++;
    memberListener = success;
    memberError = failure;
    return () => {};
  },
}));
mock.module("@/pager/firebase", () => ({
  getFirebase: () => ({ auth, database: {} }),
}));
mock.module("expo-notifications", () => ({
  dismissAllNotificationsAsync: async () => {
    dismissed++;
  },
  clearLastNotificationResponseAsync: async () => {
    cleared++;
  },
}));
mock.module("@/pager/database", () => ({
  initializeDatabase: () => {},
  cachedApproval: (uid: string) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    return uid === cachedUid;
  },
  cacheApproval: (uid: string, approved: boolean) => {
    if (cacheFailure) throw new Error("Cache unavailable");
    cacheWrites.push([uid, approved]);
    if (approved) cachedUid = uid;
    else if (cachedUid === uid) cachedUid = null;
  },
}));
mock.module("@/components/ui/toast", () => ({
  showErrorToast: (message: string) => errors.push(message),
}));
const { ConnectionProvider } = await import("@/pager/connection-provider");

function render() {
  stateIndex = 0;
  refIndex = 0;
  effects.length = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Exercise captured effects without a native renderer.
  const element = ConnectionProvider({ children: null }) as ReactElement<{
    value: ConnectionValue;
  }>;
  return element.props.value;
}
async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function initialize() {
  render();
  const result = effects[0]!();
  if (typeof result === "function") cleanup = result;
  await settle();
  return render();
}
function member(approved: boolean, fromCache = false) {
  memberListener?.({ metadata: { fromCache }, data: () => ({ approved }) });
}

beforeEach(() => {
  states.length = 0;
  refs.length = 0;
  errors.length = 0;
  cacheWrites.length = 0;
  auth.currentUser = { uid: "firebase-device" };
  cachedUid = null;
  cacheFailure = false;
  signInFailure = false;
  memberSubscriptions = 0;
  dismissed = 0;
  cleared = 0;
  signIns = 0;
  authReady = undefined;
  authListener = undefined;
  memberListener = undefined;
  memberError = undefined;
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("persisted Firebase identity loads before member subscriptions", async () => {
  let finish = () => {};
  authReady = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const initial = await initialize();
  expect(initial.ready).toBe(false);
  expect(memberSubscriptions).toBe(0);
  finish();
  await settle();
  expect(render().uid).toBe("firebase-device");
  expect(signIns).toBe(0);
  expect(memberSubscriptions).toBe(1);
});

test("only a matching previously approved identity has offline access", async () => {
  cachedUid = "firebase-device";
  expect((await initialize()).connection).toEqual({ uid: "firebase-device" });
  member(false, true);
  expect(render().approved).toBe(true);
  expect(cacheWrites).toEqual([]);
  auth.currentUser = { uid: "different-device" };
  expect(render().hasAccess("firebase-device")).toBe(false);
  authListener?.(auth.currentUser);
  expect(render().connection).toBeNull();
  expect(cachedUid).toBe("firebase-device");
});

test("old Convex cache cannot approve a Firebase identity", async () => {
  cachedUid = "old-convex-device";
  expect((await initialize()).connection).toBeNull();
  member(true, true);
  expect(render().connection).toBeNull();
  member(true);
  expect(render().connection).toEqual({ uid: "firebase-device" });
  expect(cacheWrites).toEqual([["firebase-device", true]]);
});

test("server revocation clears offline approval and dismisses notifications", async () => {
  cachedUid = "firebase-device";
  await initialize();
  member(false);
  const value = render();
  expect(value.connection).toBeNull();
  expect(value.hasAccess("firebase-device")).toBe(false);
  expect(cachedUid).toBeNull();
  expect(cacheWrites).toEqual([["firebase-device", false]]);
  expect([dismissed, cleared]).toEqual([1, 1]);
});

test("late member callbacks cannot write cache after an identity change or cleanup", async () => {
  await initialize();
  const oldCallback = memberListener;
  auth.currentUser = { uid: "replacement-device" };
  authListener?.(auth.currentUser);
  oldCallback?.({
    metadata: { fromCache: false },
    data: () => ({ approved: true }),
  });
  expect(cacheWrites).toEqual([]);
  const latestCallback = memberListener;
  cleanup?.();
  cleanup = undefined;
  latestCallback?.({
    metadata: { fromCache: false },
    data: () => ({ approved: true }),
  });
  expect(cacheWrites).toEqual([]);
});

test("member failures use the error toast while keeping matching saved approval", async () => {
  cachedUid = "firebase-device";
  await initialize();
  memberError?.(new Error("Approval unavailable"));
  const value = render();
  effects[1]!();
  expect(value.connection).toEqual({ uid: "firebase-device" });
  expect(value.error).toBe("Approval unavailable");
  expect(errors).toEqual(["Approval unavailable"]);
});

test("cache failures do not block live approval and revocation", async () => {
  cacheFailure = true;
  await initialize();
  member(true);
  expect(render().approved).toBe(true);
  member(false);
  expect(render().approved).toBe(false);
  expect(errors).toContain("Could not read saved device approval.");
  expect(errors).toContain(
    "Could not clear saved history. Offline history may remain on this device.",
  );
});

test("new anonymous identities require approval and sign-in failures stay retryable", async () => {
  auth.currentUser = null;
  signInFailure = true;
  const failed = await initialize();
  expect(failed.ready).toBe(true);
  expect(failed.error).toBe("Cannot sign in");
  expect(memberSubscriptions).toBe(0);
  cleanup?.();
  signInFailure = false;
  const recovered = await initialize();
  expect(recovered.uid).toBe("new-firebase-device");
  expect(recovered.connection).toBeNull();
  expect(signIns).toBe(2);
});

test("cleanup during auth hydration prevents subscriptions and state updates", async () => {
  let finish = () => {};
  authReady = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await initialize();
  cleanup?.();
  cleanup = undefined;
  finish();
  await settle();
  expect(render().uid).toBeNull();
  expect(memberSubscriptions).toBe(0);
});
