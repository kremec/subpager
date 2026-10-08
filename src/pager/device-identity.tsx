import { type FC, useState } from "react";
import { Pressable } from "react-native";

import { setStringAsync } from "expo-clipboard";

import { IconCheck, IconCopy } from "@tabler/icons-react-native";

import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useTheme } from "@/theme/use-theme";

export const DeviceIdentity: FC = () => {
  const { uid } = useConnection();
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!uid) return;
    try {
      await setStringAsync(uid);
      setCopied(true);
    } catch {
      showErrorToast("Could not copy device ID. Try again.");
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        copied ? "Device ID copied" : `Copy device ID ${uid ?? ""}`
      }
      accessibilityState={{ disabled: !uid }}
      disabled={!uid}
      onPress={() => void copy()}
      style={({ pressed }) => ({
        minHeight: 70,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.lg,
        backgroundColor: pressed
          ? theme.colors.backgroundElement
          : theme.colors.surface,
      })}
    >
      <Typography style={{ includeFontPadding: false }}>Device ID</Typography>
      <Typography
        variant="mono"
        color={theme.colors.textSecondary}
        numberOfLines={1}
        ellipsizeMode="middle"
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "right",
          includeFontPadding: false,
        }}
      >
        {uid ?? "Creating…"}
      </Typography>
      {copied ? (
        <IconCheck color={theme.colors.success} size={20} strokeWidth={1.8} />
      ) : (
        <IconCopy
          color={theme.colors.textSecondary}
          size={20}
          strokeWidth={1.8}
        />
      )}
    </Pressable>
  );
};
