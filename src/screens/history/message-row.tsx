import { type FC } from "react";
import { Pressable, View } from "react-native";

import { useRouter } from "expo-router";

import { Typography } from "@/components/ui/typography";
import {
  formatMessageContent,
  formatReceivedAt,
  formatRicUnit,
} from "@/pager/format-message";
import type { PagerMessage } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface MessageRowProps {
  message: PagerMessage;
  unitName?: string;
}
export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message, unitName } = props;
  const theme = useTheme();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Message for ${formatRicUnit(message.ric, unitName)}`}
      onPress={() =>
        router.push({
          pathname: "/message/[id]",
          params: { id: String(message.id) },
        })
      }
      style={({ pressed }) => ({
        opacity: pressed ? 0.65 : 1,
        padding: theme.spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: theme.spacing.sm,
      })}
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
      <Typography style={{ lineHeight: 23 }}>
        {formatMessageContent(message.content) || "Tone-only call"}
      </Typography>
      {message.duplicateOf !== null && (
        <Typography variant="caption" color={theme.colors.textSecondary}>
          Repeated transmission
        </Typography>
      )}
    </Pressable>
  );
};
