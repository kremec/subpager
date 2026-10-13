import { type FC } from "react";
import { Switch, View } from "react-native";

import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { DeviceIdentity } from "@/pager/device-identity";
import { saveMessagePreference } from "@/pager/firebase";
import type { MessagePreferences } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

export const SettingsScreen: FC = () => {
  const theme = useTheme();
  const { connection, serverTokenKnown, showTestMessages, showVajaMessages } =
    useConnection();
  const savePreference = async (
    preference: keyof MessagePreferences,
    enabled: boolean,
  ) => {
    if (!connection) return;
    try {
      await saveMessagePreference(connection.uid, preference, enabled);
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? `Could not save message settings: ${error.message}`
          : "Could not save message settings.",
      );
    }
  };
  return (
    <View
      style={{
        padding: theme.spacing.lg,
        paddingBottom: theme.spacing.xl,
        gap: theme.spacing.lg,
      }}
    >
      {(
        [
          {
            preference: "showTestMessages",
            label: "Show test messages and notifications",
            enabled: showTestMessages,
          },
          {
            preference: "showVajaMessages",
            label: "Show drill messages and notifications",
            enabled: showVajaMessages,
          },
        ] as const
      ).map(({ preference, label, enabled }) => (
        <View
          key={preference}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.spacing.md,
          }}
        >
          <Typography style={{ flex: 1 }}>{label}</Typography>
          <Switch
            accessibilityLabel={label}
            value={enabled}
            disabled={!connection || !serverTokenKnown}
            onValueChange={(value) => {
              void savePreference(preference, value);
            }}
          />
        </View>
      ))}
      <DeviceIdentity />
    </View>
  );
};
