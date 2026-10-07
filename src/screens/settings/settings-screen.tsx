import { type FC, useState } from "react";
import { Alert, TextInput } from "react-native";

import { useRouter } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useTheme } from "@/theme/use-theme";

export const SettingsScreen: FC = () => {
  const { connection, save, disconnect, pushStatus } = useConnection();
  const router = useRouter();
  const theme = useTheme();
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(connection?.apiKey ?? "");
  const [rics, setRics] = useState(connection?.rics.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputStyle = {
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    borderRadius: theme.radius.sm,
    fontSize: theme.typography.body,
  };

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await save({
        baseUrl,
        apiKey,
        rics: rics.trim()
          ? rics
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
              .map(Number)
          : [],
      });
      router.back();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    setBusy(true);
    setError(null);
    try {
      await disconnect();
      setBaseUrl("");
      setApiKey("");
      setRics("");
      router.back();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll>
      <Typography>Server URL</Typography>
      <TextInput
        accessibilityLabel="Server URL"
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://pager.example.com"
        placeholderTextColor={theme.colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!busy}
        style={inputStyle}
      />
      <Typography>Device key</Typography>
      <TextInput
        accessibilityLabel="Device key"
        value={apiKey}
        onChangeText={setApiKey}
        placeholder="Paste the key from your server"
        placeholderTextColor={theme.colors.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        editable={!busy}
        style={inputStyle}
      />
      <Typography>Alert RICs</Typography>
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
      <Typography variant="caption" color={theme.colors.textSecondary}>
        Leave RICs empty to receive all alerts your device key allows. This
        selects push alerts; it does not restrict history access.
      </Typography>
      <Typography variant="caption">{pushStatus}</Typography>
      {error && (
        <Typography accessibilityRole="alert" color={theme.colors.danger}>
          {error}
        </Typography>
      )}
      <Button
        label={busy ? "Saving…" : "Save and connect"}
        disabled={busy}
        onPress={() => {
          void connect();
        }}
      />
      {connection && (
        <Button
          label="Disconnect and erase saved history"
          disabled={busy}
          onPress={() =>
            Alert.alert(
              "Disconnect?",
              "Push registration and saved history will be removed. The server must be reachable.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Disconnect",
                  style: "destructive",
                  onPress: () => {
                    void removeConnection();
                  },
                },
              ],
            )
          }
        />
      )}
    </Screen>
  );
};
