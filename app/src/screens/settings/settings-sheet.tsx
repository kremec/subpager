import { type FC } from "react";
import { View } from "react-native";

import { DeviceIdentity } from "@/components/device-identity";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Switch } from "@/components/ui/switch";
import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { saveMessagePreference } from "@/pager/firebase";
import type { MessagePreferences } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface SettingsSheetProps {
  visible: boolean;
  onClose: () => void;
}

export const SettingsSheet: FC<SettingsSheetProps> = (props) => {
  const { visible, onClose } = props;
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
    <BottomSheet visible={visible} onClose={onClose}>
      <View
        style={{
          width: "100%",
          maxWidth: 820,
          alignSelf: "center",
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
    </BottomSheet>
  );
};
