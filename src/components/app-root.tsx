import { type FC } from "react";
import { ActivityIndicator } from "react-native";

import { Stack } from "expo-router";

import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useNotifications } from "@/pager/use-notifications";
import { useTheme } from "@/theme/use-theme";

export const AppRoot: FC = () => {
  const { ready, error } = useConnection();
  const theme = useTheme();
  useNotifications();
  if (!ready)
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  if (error)
    return (
      <Screen>
        <Typography accessibilityRole="alert">
          Could not initialize the app: {error}
        </Typography>
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
        options={{ title: "Connection", presentation: "modal" }}
      />
      <Stack.Screen name="message/[id]" options={{ title: "Pager message" }} />
    </Stack>
  );
};
