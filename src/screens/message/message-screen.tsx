import { type FC, useEffect } from "react";

import { useLocalSearchParams } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import {
  formatMessageContent,
  formatReceivedAt,
  formatRicUnit,
} from "@/pager/format-message";
import { useMessageHistory } from "@/pager/use-message-history";
import { useTheme } from "@/theme/use-theme";

export const MessageScreen: FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { connection, hasAccess } = useConnection();
  const { messages, unitNames, loading, refresh } = useMessageHistory();
  const theme = useTheme();
  const messageId = Number(id);
  const allowed = !!connection && hasAccess(connection.uid);
  const message = allowed
    ? messages.find((item) => item.id === messageId)
    : undefined;
  let error: string | null = null;
  if (!Number.isSafeInteger(messageId) || messageId <= 0)
    error = "Invalid message ID.";
  if (!allowed) error = "This device needs approval to read messages.";
  useEffect(() => {
    if (error) showErrorToast(error);
  }, [error]);

  return (
    <Screen scroll>
      {message && (
        <Typography variant="title">
          {formatRicUnit(message.ric, unitNames.get(message.ric))}
        </Typography>
      )}
      {message && (
        <Typography color={theme.colors.textSecondary}>
          {formatReceivedAt(message.receivedAt)} · {message.type} · Function{" "}
          {message.function}
        </Typography>
      )}
      {message && (
        <Typography selectable style={{ lineHeight: 23 }}>
          {formatMessageContent(message.content) || "Tone-only call"}
        </Typography>
      )}
      {message?.duplicateOf !== null && message?.duplicateOf !== undefined && (
        <Typography variant="caption">
          Repeated transmission of message #{message.duplicateOf}
        </Typography>
      )}
      {!message && !error && (
        <Typography>
          {loading ? "Loading message…" : "Message not found."}
        </Typography>
      )}
      <Button label="Refresh" onPress={refresh} />
    </Screen>
  );
};
