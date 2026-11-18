import { type FC } from "react";
import { ActivityIndicator, View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

export const AppLoadingScreen: FC = () => {
  const theme = useTheme();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        alignItems: "center",
        gap: theme.spacing.md,
      }}
    >
      <ActivityIndicator color={theme.colors.accent} />
      <Typography variant="bodySmall">Loading</Typography>
    </View>
  );
};
