import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { mutateDevice } from "@/pager/api";
import { useConnection } from "@/pager/connection-provider";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function useNotifications() {
  const { connection, refresh, pushStatus, setPushStatus } = useConnection();
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!connection || !response) return;
    const messageId = response.notification.request.content.data?.messageId;
    if (
      typeof messageId === "number" &&
      Number.isSafeInteger(messageId) &&
      messageId > 0
    ) {
      router.push({
        pathname: "/message/[id]",
        params: { id: String(messageId) },
      });
    }
    void Notifications.clearLastNotificationResponseAsync();
  }, [connection, response, router]);

  useEffect(() => {
    if (!connection) {
      setPushStatus("Not connected");
      return;
    }
    let cancelled = false;
    let running = false;
    async function register() {
      if (running || cancelled || !connection) return;
      running = true;
      try {
        if (Platform.OS === "android")
          await Notifications.setNotificationChannelAsync("pager-alerts", {
            name: "Pager alerts",
            importance: Notifications.AndroidImportance.HIGH,
            sound: "default",
            vibrationPattern: [0, 250, 250, 250],
          });
        const permission = await Notifications.requestPermissionsAsync();
        if (cancelled) return;
        if (!permission.granted) {
          await mutateDevice(connection);
          if (!cancelled)
            setPushStatus("Notifications disabled in phone settings");
          return;
        }
        const projectId: string | undefined =
          Constants.expoConfig?.extra?.eas?.projectId ??
          Constants.easConfig?.projectId;
        if (!projectId)
          throw new Error(
            "Install a development or release build to enable push notifications.",
          );
        const expoPushToken = (
          await Notifications.getExpoPushTokenAsync({ projectId })
        ).data;
        if (cancelled) return;
        await mutateDevice(connection, {
          expoPushToken,
          rics: connection.rics,
        });
        if (!cancelled) setPushStatus("Push notifications registered");
      } catch (error) {
        if (!cancelled)
          setPushStatus(
            error instanceof Error ? error.message : "Push registration failed",
          );
      } finally {
        running = false;
      }
    }
    void register();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refresh();
        void register();
      }
    });
    const received = Notifications.addNotificationReceivedListener(refresh);
    const tokenChanged = Notifications.addPushTokenListener(() => {
      void register();
    });
    return () => {
      cancelled = true;
      appState.remove();
      received.remove();
      tokenChanged.remove();
    };
  }, [connection, refresh, setPushStatus]);

  return pushStatus;
}
