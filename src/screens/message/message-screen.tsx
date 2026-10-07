import { type FC, useEffect, useState } from "react";

import { useLocalSearchParams } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { request } from "@/pager/api";
import { useConnection } from "@/pager/connection-provider";
import { cachedMessage, cacheMessages } from "@/pager/database";
import type { PagerMessage } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

export const MessageScreen: FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { connection, revision, refresh } = useConnection();
  const [message, setMessage] = useState<PagerMessage>();
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  useEffect(() => {
    const messageId = Number(id);
    // Read the external SQLite cache before requesting the current message.
    // oxlint-disable-next-line react/set-state-in-effect
    setMessage(connection ? cachedMessage(messageId) : undefined);
    if (!connection) {
      setError("Connect to a server to read this message.");
      return;
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      setError("Invalid message ID.");
      return;
    }
    const controller = new AbortController();
    setError(null);
    void request<PagerMessage>(connection, `/v1/messages/${messageId}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        cacheMessages([value]);
        setMessage(value);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [connection, id, revision]);

  return (
    <Screen scroll>
      {message && <Typography variant="title">RIC {message.ric}</Typography>}
      {message && (
        <Typography color={theme.colors.textSecondary}>
          {new Date(message.receivedAt).toLocaleString()} · {message.type} ·
          Function {message.function}
        </Typography>
      )}
      {message && (
        <Typography selectable>
          {message.content || "Tone-only call"}
        </Typography>
      )}
      {message?.duplicateOf !== null && message?.duplicateOf !== undefined && (
        <Typography variant="caption">
          Repeated transmission of message #{message.duplicateOf}
        </Typography>
      )}
      {error && (
        <Typography accessibilityRole="alert" color={theme.colors.danger}>
          {error}
        </Typography>
      )}
      {!message && !error && <Typography>Loading message…</Typography>}
      <Button label="Refresh" onPress={refresh} />
    </Screen>
  );
};
