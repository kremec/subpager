import Constants from "expo-constants";

import { api } from "@convex/_generated/api";
import { ConvexReactClient } from "convex/react";

import type { PagerMessage, RicUnit } from "@/pager/types";

let client: ConvexReactClient | undefined;

export function getConvex() {
  const url: string | undefined = Constants.expoConfig?.extra?.convexUrl;
  if (!url)
    throw new Error(
      "Convex is not configured in this build. Ask the administrator for a configured app.",
    );
  client ??= new ConvexReactClient(url);
  return client;
}

export function watchMessages(
  onMessages: (messages: PagerMessage[]) => void,
  onError: (error: Error) => void,
) {
  const watch = getConvex().watchQuery(api.messages.list, {});
  const update = () => {
    try {
      const messages = watch.localQueryResult();
      if (messages !== undefined) onMessages(messages);
    } catch (error) {
      onError(
        error instanceof Error ? error : new Error("History sync failed."),
      );
    }
  };
  const unsubscribe = watch.onUpdate(update);
  update();
  return unsubscribe;
}

export function watchRicUnits(
  onUnits: (units: RicUnit[]) => void,
  onError: (error: Error) => void,
) {
  const watch = getConvex().watchQuery(api.units.list, {});
  const update = () => {
    try {
      const units = watch.localQueryResult();
      if (units !== undefined) onUnits(units);
    } catch (error) {
      onError(error instanceof Error ? error : new Error("Unit sync failed."));
    }
  };
  const unsubscribe = watch.onUpdate(update);
  update();
  return unsubscribe;
}

export function registerDevice(expoPushToken: string | null) {
  return getConvex().mutation(api.devices.register, { expoPushToken });
}
