import { Fragment, type FC, useState } from "react";
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
  const { rics } = message;
  const theme = useTheme();
  const [headerWidth, setHeaderWidth] = useState(0);
  const [dateWidth, setDateWidth] = useState(0);
  const [labelWidths, setLabelWidths] = useState<Record<number, number>>({});
  let firstLineCount = 0;
  let usedWidth = dateWidth;
  for (const ric of rics) {
    const width = labelWidths[ric];
    if (!width || usedWidth + width + 4 > headerWidth) break;
    usedWidth += width + 4;
    firstLineCount++;
  }
  const date = (
    <Typography
      variant="caption"
      color={theme.colors.textSecondary}
      onLayout={(event) => setDateWidth(event.nativeEvent.layout.width)}
      style={{
        marginLeft: "auto",
        paddingLeft: theme.spacing.md,
        flexShrink: 0,
      }}
    >
      {formatReceivedAt(message.receivedAt)}
    </Typography>
  );
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
        onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-start",
          columnGap: 4,
        }}
      >
        {firstLineCount === 0 && date}
        {firstLineCount === 0 && <View style={{ width: "100%" }} />}
        {rics.map((ric, index) => (
          <Fragment key={ric}>
            <Typography
              variant="bodySmall"
              onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                setLabelWidths((current) =>
                  current[ric] === width
                    ? current
                    : { ...current, [ric]: width },
                );
              }}
              style={{ flexShrink: 0, fontWeight: "600" }}
            >
              {formatRicUnit(ric, unitNames?.get(ric)).replace(/\s/g, "\u00a0")}
              {index < rics.length - 1 && ","}
            </Typography>
            {index === firstLineCount - 1 && date}
            {index === firstLineCount - 1 && <View style={{ width: "100%" }} />}
          </Fragment>
        ))}
      </View>
      <MessageContent message={message} />
      {spinEvent && (
        <SpinReport key={`${message.id}:${spinEvent.id}`} event={spinEvent} />
      )}
    </View>
  );
};
