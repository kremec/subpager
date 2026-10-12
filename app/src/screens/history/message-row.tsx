import { type FC } from "react";
import { View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { formatReceivedAt, formatRicUnit } from "@/pager/format-message";
import { MessageContent } from "@/pager/message-content";
import { SpinReport } from "@/pager/spin-report";
import type { PagerMessage, SpinEvent } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface MessageRowProps {
  message: PagerMessage;
  unitName?: string;
  spinEvent?: SpinEvent;
}
export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message, unitName, spinEvent } = props;
  const theme = useTheme();
  return (
    <View
      style={{
        padding: theme.spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: theme.spacing.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.md,
        }}
      >
        <Typography variant="bodySmall" style={{ flex: 1, fontWeight: "600" }}>
          {formatRicUnit(message.ric, unitName)}
        </Typography>
        <Typography variant="caption" color={theme.colors.textSecondary}>
          {formatReceivedAt(message.receivedAt)}
        </Typography>
      </View>
      <MessageContent message={message} />
      {spinEvent && (
        <SpinReport key={`${message.id}:${spinEvent.id}`} event={spinEvent} />
      )}
    </View>
  );
};
