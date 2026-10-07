import { type FC } from "react";
import { Pressable, View } from "react-native";

import { useRouter } from "expo-router";

import { Typography } from "@/components/ui/typography";
import type { PagerMessage } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface MessageRowProps {
  message: PagerMessage;
}
export const MessageRow: FC<MessageRowProps> = (props) => {
  const { message } = props;
  const theme = useTheme();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Message for RIC ${message.ric}`}
      onPress={() =>
        router.push({
          pathname: "/message/[id]",
          params: { id: String(message.id) },
        })
      }
      style={{
        padding: theme.spacing.lg,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
        gap: theme.spacing.sm,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: theme.spacing.md,
        }}
      >
        <Typography variant="bodyStrong">RIC {message.ric}</Typography>
        <Typography variant="caption" color={theme.colors.textSecondary}>
          {new Date(message.receivedAt).toLocaleString()}
        </Typography>
      </View>
      <Typography numberOfLines={4}>
        {message.content || "Tone-only call"}
      </Typography>
      {message.duplicateOf !== null && (
        <Typography variant="caption" color={theme.colors.textSecondary}>
          Repeated transmission
        </Typography>
      )}
    </Pressable>
  );
};
