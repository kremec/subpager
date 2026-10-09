import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { DevicePushToken, ExpoPushTokenOptions } from "expo-notifications";
import type { EffectCallback } from "react";

const effects: EffectCallback[] = [];
let nativeToken: DevicePushToken = { type: "android", data: "first" };
let tokenListener: ((token: DevicePushToken) => void) | undefined;
let appStateListener: ((state: string) => void) | undefined;
let cleanup: (() => void) | undefined;
let conversionCalls = 0;
let failWrites = 0;
let granted = true;
let approved = true;
let serverTokenKnown = true;
let serverToken: string | null | undefined = null;
let permissionLookup: (() => Promise<void>) | undefined;
let tokenLookup: (() => Promise<void>) | undefined;
let response: {
  notification: {
    request: { content: { data: { messageId?: string } } };
  };
} | null = null;
let clearedResponses = 0;
const openedRoutes: string[] = [];
const writes: (string | null)[] = [];
const failures: string[] = [];
const statuses: string[] = [];
let writeAcknowledgement: (() => Promise<void>) | undefined;

mock.module("react", () => ({
  useEffect: (effect: EffectCallback) => effects.push(effect),
}));
mock.module("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListener = listener;
      return { remove: () => (appStateListener = undefined) };
    },
  },
}));
mock.module("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "test-project" } } } },
}));
mock.module("expo-router", () => ({
  useRouter: () => ({
    replace: (route: string) => openedRoutes.push(route),
  }),
}));
mock.module("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationHandler: () => {},
  useLastNotificationResponse: () => response,
  clearLastNotificationResponseAsync: async () => {
    clearedResponses++;
  },
  setNotificationChannelAsync: async () => {},
  getPermissionsAsync: async () => {
    await permissionLookup?.();
    return { granted, canAskAgain: false };
  },
  getExpoPushTokenAsync: async (options: ExpoPushTokenOptions) => {
    conversionCalls++;
    // Bound a broken loop so the regression fails instead of hanging the suite.
    if (conversionCalls > 20) throw new Error("Repeated native token lookup");
    const token = options.devicePushToken ?? nativeToken;
    if (!options.devicePushToken) tokenListener?.(token);
    await tokenLookup?.();
    return { data: `ExpoPushToken[${token.data}]` };
  },
  addPushTokenListener: (listener: (token: DevicePushToken) => void) => {
    tokenListener = listener;
    return { remove: () => (tokenListener = undefined) };
  },
}));
mock.module("@/pager/connection-provider", () => ({
  useConnection: () => ({
    connection: approved ? { uid: "test-device" } : null,
    pushStatus: "",
    serverTokenKnown,
    getRegisteredToken: () => serverToken,
    confirmRegisteredToken: (uid: string, token: string | null) => {
      expect(uid).toBe("test-device");
      serverToken = token;
    },
    setPushStatus: (status: string) => statuses.push(status),
  }),
}));
mock.module("@/pager/firebase", () => ({
  registerDevice: async (uid: string, token: string | null) => {
    expect(uid).toBe("test-device");
    await writeAcknowledgement?.();
    writes.push(token);
    if (failWrites > 0) {
      failWrites--;
      throw new Error("Registration failed");
    }
  },
}));
mock.module("@/components/ui/toast", () => ({
  showErrorToast: (message: string) => failures.push(message),
}));

const { useNotifications } = await import("@/pager/use-notifications");

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function mount() {
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Run captured effects without a native renderer.
  useNotifications();
  const result = effects[1]!();
  if (typeof result === "function") cleanup = result;
  await settle();
}

function emitToken(value: string) {
  nativeToken = { type: "android", data: value };
  tokenListener?.(nativeToken);
}

beforeEach(() => {
  effects.length = 0;
  writes.length = 0;
  failures.length = 0;
  statuses.length = 0;
  writeAcknowledgement = undefined;
  conversionCalls = 0;
  failWrites = 0;
  granted = true;
  approved = true;
  serverTokenKnown = true;
  serverToken = null;
  permissionLookup = undefined;
  tokenLookup = undefined;
  response = null;
  clearedResponses = 0;
  openedRoutes.length = 0;
  nativeToken = { type: "android", data: "first" };
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test("native token lookup terminates and unchanged tokens write only once", async () => {
  await mount();
  expect(conversionCalls).toBeLessThanOrEqual(2);
  expect(writes).toEqual(["ExpoPushToken[first]"]);

  emitToken("first");
  await settle();
  appStateListener?.("active");
  await settle();
  expect(conversionCalls).toBeLessThanOrEqual(5);
  expect(writes).toEqual(["ExpoPushToken[first]"]);
  expect(failures).toEqual([]);
});

test("push registration waits for an approved connection", async () => {
  approved = false;
  await mount();
  expect(conversionCalls).toBe(0);
  expect(writes).toEqual([]);
  approved = true;
  effects.length = 0;
  await mount();
  expect(writes).toEqual(["ExpoPushToken[first]"]);
});

test("push success waits for server acknowledgement of queued writes", async () => {
  let acknowledge = () => {};
  writeAcknowledgement = () =>
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
  await mount();
  expect(statuses).not.toContain("Push notifications registered");
  expect(writes).toEqual([]);
  writeAcknowledgement = undefined;
  acknowledge();
  await settle();
  expect(statuses).toContain("Push notifications registered");
  expect(writes).toEqual(["ExpoPushToken[first]"]);
});

test("a changed token writes once and the latest queued native token is retained", async () => {
  await mount();
  emitToken("second");
  emitToken("third");
  emitToken("latest");
  await settle();
  expect(writes).toEqual([
    "ExpoPushToken[first]",
    "ExpoPushToken[second]",
    "ExpoPushToken[latest]",
  ]);
  emitToken("latest");
  await settle();
  expect(writes).toHaveLength(3);
  expect(failures).toEqual([]);
});

test("failed registration stays retryable instead of being marked successful", async () => {
  await mount();
  failWrites = 1;
  emitToken("second");
  await settle();
  expect(failures).toEqual(["Registration failed"]);
  emitToken("second");
  await settle();
  emitToken("second");
  await settle();
  expect(writes).toEqual([
    "ExpoPushToken[first]",
    "ExpoPushToken[second]",
    "ExpoPushToken[second]",
  ]);
});

test("cleanup removes token and foreground listeners", async () => {
  await mount();
  cleanup?.();
  cleanup = undefined;
  expect(tokenListener).toBeUndefined();
  expect(appStateListener).toBeUndefined();
  emitToken("second");
  await settle();
  expect(writes).toEqual(["ExpoPushToken[first]"]);
});

test("permission changes clear and restore tokens without repeated writes", async () => {
  await mount();
  granted = false;
  appStateListener?.("active");
  await settle();
  appStateListener?.("active");
  await settle();
  expect(writes).toEqual(["ExpoPushToken[first]", null]);
  granted = true;
  appStateListener?.("active");
  await settle();
  expect(writes).toEqual([
    "ExpoPushToken[first]",
    null,
    "ExpoPushToken[first]",
  ]);
});

test("cleanup while checking permission prevents token lookup and writes", async () => {
  let finish = () => {};
  permissionLookup = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await mount();
  cleanup?.();
  cleanup = undefined;
  finish();
  await settle();
  expect(conversionCalls).toBe(0);
  expect(writes).toEqual([]);
});

test("cleanup during Expo lookup prevents writes and queued registration", async () => {
  let finish = () => {};
  tokenLookup = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  await mount();
  cleanup?.();
  cleanup = undefined;
  finish();
  await settle();
  expect(conversionCalls).toBe(1);
  expect(writes).toEqual([]);
  expect(failures).toEqual([]);
});

test("quota errors stop registration attempts until another external event", async () => {
  failWrites = 100;
  await mount();
  const attempts = writes.length;
  expect(attempts).toBeLessThanOrEqual(2);
  await settle();
  expect(writes).toHaveLength(attempts);
  failWrites = 0;
  appStateListener?.("active");
  await settle();
  expect(writes).toHaveLength(attempts + 1);
});

test("notification taps open the feed only after approval", () => {
  response = {
    notification: {
      request: { content: { data: { messageId: "native-message-id" } } },
    },
  };
  approved = false;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Run captured effects without a native renderer.
  useNotifications();
  effects[0]!();
  expect(openedRoutes).toEqual([]);
  expect(clearedResponses).toBe(0);

  effects.length = 0;
  approved = true;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Simulate approval with a pending tap.
  useNotifications();
  effects[0]!();
  expect(openedRoutes).toEqual(["/"]);
  expect(clearedResponses).toBe(1);

  response.notification.request.content.data = {};
  effects.length = 0;
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Feed navigation does not depend on message metadata.
  useNotifications();
  effects[0]!();
  expect(openedRoutes).toEqual(["/", "/"]);
  expect(clearedResponses).toBe(2);
});

test("unchanged tokens on a cold start do not write", async () => {
  serverToken = "ExpoPushToken[first]";
  await mount();
  expect(writes).toEqual([]);
  expect(statuses).toContain("Push notifications registered");
});

test("registration waits for the existing user listener to confirm the server token", async () => {
  serverTokenKnown = false;
  serverToken = undefined;
  await mount();
  expect(conversionCalls).toBe(0);
  expect(writes).toEqual([]);
  serverTokenKnown = true;
  serverToken = "ExpoPushToken[first]";
  effects.length = 0;
  await mount();
  expect(writes).toEqual([]);
});

test("server-cleared tokens are restored on foreground even when the device token is unchanged", async () => {
  await mount();
  serverToken = null;
  appStateListener?.("active");
  await settle();
  expect(writes).toEqual(["ExpoPushToken[first]", "ExpoPushToken[first]"]);
});
