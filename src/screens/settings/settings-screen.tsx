import { type FC, useState } from "react";
import { TextInput } from "react-native";

import { setStringAsync } from "expo-clipboard";
import { useRouter } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useTheme } from "@/theme/use-theme";

export const SettingsScreen: FC = () => {
  const { connection, uid, approved, approvalChecked, saveRics, pushStatus } =
    useConnection();
  const router = useRouter();
  const theme = useTheme();
  const [rics, setRics] = useState(connection?.rics.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputStyle = {
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    borderRadius: theme.radius.sm,
    fontSize: theme.typography.body,
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveRics(
        rics.trim()
          ? rics
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
              .map(Number)
          : [],
      );
      router.back();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save alert settings.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyUid() {
    if (!uid) return;
    try {
      await setStringAsync(uid);
      setCopied(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not copy device ID.",
      );
    }
  }

  return (
    <Screen scroll>
      <Typography>
        {approved
          ? "Approved for history and notifications"
          : approvalChecked
            ? "Waiting for administrator approval"
            : "Checking approval…"}
      </Typography>
      <Typography>Device ID</Typography>
      <Typography selectable>{uid ?? "Creating device identity…"}</Typography>
      {uid && (
        <Button
          label={copied ? "Device ID copied" : "Copy device ID"}
          onPress={() => {
            void copyUid();
          }}
        />
      )}
      <Typography variant="caption" color={theme.colors.textSecondary}>
        Share this ID with the administrator to request access. A new phone or
        cleared app data needs a new approval.
      </Typography>
      {approved && <Typography>Alert RICs</Typography>}
      {approved && (
        <TextInput
          accessibilityLabel="Alert RICs"
          value={rics}
          onChangeText={setRics}
          placeholder="All, or comma-separated RICs"
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="numbers-and-punctuation"
          editable={!busy}
          style={inputStyle}
        />
      )}
      {approved && (
        <Typography variant="caption" color={theme.colors.textSecondary}>
          Leave RICs empty to receive all alerts. This filters notifications
          only; history includes every message.
        </Typography>
      )}
      {approved && <Typography variant="caption">{pushStatus}</Typography>}
      {error && (
        <Typography accessibilityRole="alert" color={theme.colors.danger}>
          {error}
        </Typography>
      )}
      {approved && (
        <Button
          label={busy ? "Saving…" : "Save alert settings"}
          disabled={busy}
          onPress={() => {
            void save();
          }}
        />
      )}
    </Screen>
  );
};
