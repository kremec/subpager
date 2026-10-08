import { expect, mock, test } from "bun:test";
import { type FunctionReference, getFunctionName } from "convex/server";

import type { PagerMessage } from "@/pager/types";

let onUpdate: (() => void) | undefined;
let result: PagerMessage[] | undefined;
let failure: Error | undefined;
const tokens: (string | null)[] = [];

mock.module("expo-constants", () => ({
  default: {
    expoConfig: { extra: { convexUrl: "https://test.convex.cloud" } },
  },
}));
mock.module("convex/react", () => ({
  ConvexReactClient: class {
    watchQuery(query: FunctionReference<"query">) {
      expect(getFunctionName(query)).toBe("messages:list");
      return {
        onUpdate: (callback: () => void) => {
          onUpdate = callback;
          return () => {
            onUpdate = undefined;
          };
        },
        localQueryResult: () => {
          if (failure) throw failure;
          return result;
        },
      };
    }
    async mutation(
      _query: FunctionReference<"mutation">,
      args: { expoPushToken: string | null },
    ) {
      tokens.push(args.expoPushToken);
    }
  },
}));

const { watchMessages, registerDevice } = await import("@/pager/convex");

test("reactive message updates include later locations and query errors are handled", () => {
  const first: PagerMessage = {
    id: "message-1",
    receivedAt: "2026-10-08T10:00:00Z",
    ric: 123,
    function: 0,
    type: "alpha",
    content: "GORI V ŠOLI GOLO",
    duplicateOf: null,
  };
  const batches: PagerMessage[][] = [];
  const errors: string[] = [];
  const unsubscribe = watchMessages(
    (messages) => batches.push(messages),
    (error) => errors.push(error.message),
  );
  expect(batches).toEqual([]);
  result = [first];
  onUpdate?.();
  result = [{ ...first, location: "ŠOLI GOLO" }];
  onUpdate?.();
  expect(batches.at(-1)?.[0]?.location).toBe("ŠOLI GOLO");
  failure = new Error("Approval required");
  onUpdate?.();
  expect(errors).toEqual(["Approval required"]);
  failure = undefined;
  unsubscribe();
  expect(onUpdate).toBeUndefined();
});

test("re-attaching reads an already cached query result", () => {
  const batches: PagerMessage[][] = [];
  const unsubscribe = watchMessages(
    (messages) => batches.push(messages),
    () => {},
  );
  expect(batches).toEqual([result!]);
  unsubscribe();
});

test("notification permission removal explicitly clears the token", async () => {
  await registerDevice("ExponentPushToken[test]");
  await registerDevice(null);
  expect(tokens).toEqual(["ExponentPushToken[test]", null]);
});
