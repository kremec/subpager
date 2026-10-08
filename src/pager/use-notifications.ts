import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { showErrorToast } from "@/components/ui/toast";
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
    void Notifications.clearLastNotificationResponseAsync().catch(() =>
      showErrorToast("Could not clear notifications."),
    );
  }, [connection, response, router]);

  useEffect(() => {
    if (!connection) {
      setPushStatus("Waiting for approval");
      return;
    }
    let cancelled = false;
    let running = false;
    let pending = false;
    let pendingDeviceToken: Notifications.DevicePushToken | undefined;
    let registeredToken: string | null | undefined;
    const uid = connection.uid;
    async function saveToken(token: string | null) {
      if (registeredToken === token) return;
      await registerDevice(uid, token);
      registeredToken = token;
    }
    async function register(devicePushToken?: Notifications.DevicePushToken) {
      if (cancelled || !connection) return;
      if (running) {
        pending = true;
        if (devicePushToken) pendingDeviceToken = devicePushToken;
        return;
      }
      running = true;
      try {
        if (Platform.OS === "android")
          await Notifications.setNotificationChannelAsync("pager-alerts", {
            name: "Pager alerts",
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
          });
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted && permission.canAskAgain)
          permission = await Notifications.requestPermissionsAsync();
        if (cancelled) return;
        if (!permission.granted) {
          await saveToken(null);
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
          await Notifications.getExpoPushTokenAsync({
            projectId,
            devicePushToken,
          })
        ).data;
        if (cancelled) return;
        await saveToken(expoPushToken);
        if (!cancelled) setPushStatus("Push notifications registered");
      } catch (error) {
        if (!cancelled) {
          setPushStatus("Push notifications unavailable");
          showErrorToast(
            error instanceof Error ? error.message : "Push registration failed",
          );
        }
      } finally {
        running = false;
        if (pending) {
          pending = false;
          const nextToken = pendingDeviceToken;
          pendingDeviceToken = undefined;
          void register(nextToken);
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
    const tokenChanged = Notifications.addPushTokenListener((token) => {
      // Fetching the native token here would emit another token event.
      void register(token);
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
