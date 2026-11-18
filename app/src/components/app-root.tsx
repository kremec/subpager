import { type FC } from "react";

import { Stack } from "expo-router";

import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppLoadingScreen } from "@/components/app-loading-screen";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { useNotifications } from "@/notifications/use-notifications";
import { useConnection } from "@/pager/connection-provider";
import { useTheme } from "@/theme/use-theme";

export const AppRoot: FC = () => {
  const { ready, uid, error, retry } = useConnection();
  const theme = useTheme();
  useNotifications();
  if (!ready) return <AppLoadingScreen />;
  if (error && !uid)
    return (
      <Screen>
        <Button onPress={retry}>Retry</Button>
      </Screen>
    );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.text,
          contentStyle: { backgroundColor: theme.colors.background },
          statusBarStyle: theme.themeName === "dark" ? "light" : "dark",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="search"
          options={{ presentation: "modal", headerShown: false }}
        />
        {__DEV__ && (
          <Stack.Screen
            name="spin-preview"
            options={{ title: "SPIN preview" }}
          />
        )}
      </Stack>
    </GestureHandlerRootView>
  );
};
