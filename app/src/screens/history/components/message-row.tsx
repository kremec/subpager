import { type FC } from "react";
import { View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { formatReceivedAt, formatRicUnit } from "@/pager/format-message";
import type { PagerMessage, SpinEvent } from "@/pager/types";
import { MessageContent } from "@/screens/history/components/message-content";
import { SpinReport } from "@/screens/history/components/spin-report";
import { useTheme } from "@/theme/use-theme";
import { withoutEchoes } from "@shared/pager-receptions";

interface MessageRowProps {
  message: PagerMessage;
  spinEvent?: SpinEvent;
}

export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message, spinEvent } = props;
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
      <View style={{ gap: theme.spacing.xs }}>
        {withoutEchoes(message.receptions).map((reception, index) => (
          <View
            key={`${reception.ric}:${reception.time}:${index}`}
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: theme.spacing.sm,
            }}
          >
            <Typography
              variant="bodySmallSemibold"
              style={{ flexShrink: 0, maxWidth: "100%" }}
            >
              {formatRicUnit(reception.ric, reception.unitName).replace(
                /\s/g,
                "\u00a0",
              )}
            </Typography>
            <Typography
              variant="caption"
              color={theme.colors.textSecondary}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            >
              {formatReceivedAt(reception.time)}
            </Typography>
          </View>
        ))}
      </View>
      <MessageContent message={message} />
      {spinEvent && (
        <SpinReport key={`${message.id}:${spinEvent.id}`} event={spinEvent} />
      )}
    </View>
  );
};
