import { type FC } from "react";
import { Text } from "react-native";

import { openURL } from "expo-linking";

import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { formatMessageContent } from "@/pager/format-message";
import { messageLocation } from "@/pager/message-location";
import type { PagerMessage } from "@/pager/types";

interface MessageContentProps {
  message: PagerMessage;
}

export const MessageContent: FC<MessageContentProps> = (props) => {
  const { message } = props;
  const span = messageLocation(message);
  return (
    <Typography style={{ lineHeight: 23 }}>
      {!span && (formatMessageContent(message.content) || "Tone-only call")}
      {span && formatMessageContent(span.before)}
      {span && (
        <Text
          accessibilityRole="link"
          accessibilityLabel={`Open ${span.location} in Google Maps`}
          style={{ textDecorationLine: "underline" }}
          onPress={(event) => {
            event.stopPropagation();
            void openURL(span.url).catch(() =>
              showErrorToast("Could not open Google Maps."),
            );
          }}
        >
          {formatMessageContent(span.location)}
        </Text>
      )}
      {span && formatMessageContent(span.after)}
    </Typography>
  );
};
