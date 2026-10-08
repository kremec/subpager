import { type FC } from "react";
import { View } from "react-native";

import { DeviceIdentity } from "@/pager/device-identity";
import { useTheme } from "@/theme/use-theme";

export const SettingsScreen: FC = () => {
  const theme = useTheme();
  return (
    <View
      style={{
        padding: theme.spacing.lg,
        paddingBottom: theme.spacing.xl,
      }}
    >
      <DeviceIdentity />
    </View>
  );
};
