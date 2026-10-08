import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { useConnection } from "@/pager/connection-provider";
import { registerDevice } from "@/pager/firebase";

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
      setPushStatus("Waiting for approval");
      return;
    }
    let cancelled = false;
    let running = false;
    let pending = false;
    async function register() {
      if (cancelled || !connection) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        if (Platform.OS === "android")
          await Notifications.setNotificationChannelAsync("pager-alerts", {
            name: "Pager alerts",
            importance: Notifications.AndroidImportance.HIGH,
            sound: "default",
            vibrationPattern: [0, 250, 250, 250],
          });
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted && permission.canAskAgain)
          permission = await Notifications.requestPermissionsAsync();
        if (cancelled) return;
        if (!permission.granted) {
          await registerDevice(connection.uid, null, connection.rics);
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
        await registerDevice(connection.uid, expoPushToken, connection.rics);
        if (!cancelled) setPushStatus("Push notifications registered");
      } catch (error) {
        if (!cancelled)
          setPushStatus(
            error instanceof Error ? error.message : "Push registration failed",
          );
      } finally {
        running = false;
        if (pending) {
          pending = false;
          void register();
        }
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
