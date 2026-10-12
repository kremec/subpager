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
  unitNames?: ReadonlyMap<number, string>;
  spinEvent?: SpinEvent;
}
export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message, unitNames, spinEvent } = props;
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
        {message.receptions
          .toSorted((a, b) => a.time.localeCompare(b.time))
          .map((reception, index) => (
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
                variant="bodySmall"
                style={{ flexShrink: 0, maxWidth: "100%", fontWeight: "600" }}
              >
                {formatRicUnit(
                  reception.ric,
                  unitNames?.get(reception.ric),
                ).replace(/\s/g, "\u00a0")}
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
