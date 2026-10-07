import { type FC } from "react";
import { FlatList, View } from "react-native";

import { useRouter } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { useMessageHistory } from "@/pager/use-message-history";
import { MessageRow } from "@/screens/history/message-row";
import { useTheme } from "@/theme/use-theme";

export const HistoryScreen: FC = () => {
  const router = useRouter();
  const theme = useTheme();
  const { connection } = useConnection();
  const { messages, status, error, loading, nextCursor, refresh, loadMore } =
    useMessageHistory();
  return (
    <Screen>
      <View style={{ gap: theme.spacing.sm }}>
        <Button
          label="Connection settings"
          onPress={() => router.push("/settings")}
        />
        {connection && (
          <Typography variant="caption" color={theme.colors.textSecondary}>
            {connection.baseUrl}
          </Typography>
        )}
        {status && (
          <Typography variant="caption">
            Receiver: {status.receiver.state}. Pending pushes:{" "}
            {status.pendingPushes}
            {status.receiver.error ? `. ${status.receiver.error}` : ""}
          </Typography>
        )}
        {status?.pushError && (
          <Typography accessibilityRole="alert" color={theme.colors.danger}>
            Push delivery error: {status.pushError}
          </Typography>
        )}
        {error && (
          <Typography accessibilityRole="alert" color={theme.colors.danger}>
            {error}. Saved history remains available.
          </Typography>
        )}
      </View>
      {!connection && (
        <Typography>
          Connect to your server with a separate device key for this phone.
        </Typography>
      )}
      {connection && (
        <FlatList
          data={messages}
          keyExtractor={(message) => String(message.id)}
          renderItem={({ item }) => <MessageRow message={item} />}
          contentContainerStyle={{
            gap: theme.spacing.md,
            paddingBottom: theme.spacing.lg,
            flexGrow: 1,
          }}
          refreshing={loading}
          onRefresh={refresh}
          ListEmptyComponent={
            <Typography color={theme.colors.textSecondary}>
              {loading
                ? "Loading messages…"
                : "No messages yet. Pull to refresh."}
            </Typography>
          }
          ListFooterComponent={
            nextCursor !== null ? (
              <Button
                label={loading ? "Loading…" : "Load older messages"}
                disabled={loading}
                onPress={loadMore}
              />
            ) : undefined
          }
        />
      )}
    </Screen>
  );
};
