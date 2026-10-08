import { type FC } from "react";
import { ActivityIndicator } from "react-native";

import { Stack } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useNotifications } from "@/pager/use-notifications";
import { useTheme } from "@/theme/use-theme";

export const AppRoot: FC = () => {
  const { ready, uid, error, retry } = useConnection();
  const theme = useTheme();
  useNotifications();
  if (!ready)
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  if (error && !uid)
    return (
      <Screen>
        <Typography accessibilityRole="alert">{error}</Typography>
        <Button label="Retry" onPress={retry} />
      </Screen>
    );
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        contentStyle: { backgroundColor: theme.colors.background },
        statusBarStyle: theme.themeName === "dark" ? "light" : "dark",
      }}
    >
      <Stack.Screen name="index" options={{ title: "subpager" }} />
      <Stack.Screen
        name="settings"
        options={{ title: "Settings", presentation: "modal" }}
      />
      <Stack.Screen name="message/[id]" options={{ title: "Pager message" }} />
    </Stack>
  );
};
