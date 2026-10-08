import { type FC } from "react";
import { View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { formatReceivedAt, formatRicUnit } from "@/pager/format-message";
import { MessageContent } from "@/pager/message-content";
import type { PagerMessage } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface MessageRowProps {
  message: PagerMessage;
  unitName?: string;
}
export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message, unitName } = props;
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
      {message.duplicateOf !== null && (
        <Typography variant="caption" color={theme.colors.textSecondary}>
          Repeated transmission
        </Typography>
      )}
    </View>
  );
};
