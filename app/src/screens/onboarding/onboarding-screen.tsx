import { type FC } from "react";
import { ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { DeviceIdentity } from "@/pager/device-identity";
import { useTheme } from "@/theme/use-theme";

export const OnboardingScreen: FC = () => {
  const { error, retry } = useConnection();
  const theme = useTheme();
  return (
    <Screen headerShown={false} style={{ gap: 0 }}>
      <View
        style={{ flex: 1, width: "100%", maxWidth: 420, alignSelf: "center" }}
      >
        <Typography variant="title" style={{ fontFamily: theme.fonts.rounded }}>
          subpager
        </Typography>
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingVertical: theme.spacing.xxl,
            gap: theme.spacing.xl,
          }}
        >
          <View style={{ gap: theme.spacing.sm }}>
            <Typography
              variant="display"
              style={{ fontFamily: theme.fonts.rounded, letterSpacing: -0.5 }}
            >
              Connect your device
            </Typography>
            <Typography color={theme.colors.textSecondary}>
              Share your device ID; approval opens the feed automatically.
            </Typography>
          </View>
          <DeviceIdentity />
          {error && <Button label="Retry connection" onPress={retry} />}
        </ScrollView>
      </View>
    </Screen>
  );
};
