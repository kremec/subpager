import { type FC, useEffect, useState } from "react";

import { useLocalSearchParams } from "expo-router";

import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useConnection } from "@/pager/connection-provider";
import { cachedMessage } from "@/pager/database";
import { getMessage } from "@/pager/firebase";
import type { PagerMessage } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

export const MessageScreen: FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { connection, revision, refresh, hasAccess } = useConnection();
  const uid = connection?.uid;
  const [message, setMessage] = useState<PagerMessage>();
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  useEffect(() => {
    const messageId = Number(id);
    // Read the external SQLite cache before requesting the current message.
    // oxlint-disable-next-line react/set-state-in-effect
    setMessage(uid && hasAccess(uid) ? cachedMessage(messageId) : undefined);
    if (!uid || !hasAccess(uid)) {
      setError("This device needs administrator approval to read messages.");
      return;
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      setError("Invalid message ID.");
      return;
    }
    const controller = new AbortController();
    setError(null);
    void getMessage(messageId)
      .then((value) => {
        if (controller.signal.aborted || !hasAccess(uid)) return;
        setMessage(value);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted && hasAccess(uid))
          setError(error.message);
      });
    return () => controller.abort();
  }, [uid, id, revision, hasAccess]);

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
