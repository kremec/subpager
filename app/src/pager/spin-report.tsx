import { type FC, useState } from "react";
import { Pressable, View } from "react-native";

import { openURL } from "expo-linking";

import {
  IconChevronDown,
  IconChevronUp,
  IconMapPin,
} from "@tabler/icons-react-native";

import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { formatReceivedAt } from "@/pager/format-message";
import type { SpinEvent } from "@/pager/types";
import { useTheme } from "@/theme/use-theme";

interface SpinReportProps {
  event: SpinEvent;
}

export const SpinReport: FC<SpinReportProps> = (props) => {
  const { event } = props;
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const location = event.municipality || event.category || event.title;
  const description = event.description.trim();
  const hasDescription =
    !!description &&
    description.toLocaleLowerCase() !==
      event.municipality?.trim().toLocaleLowerCase();
  const hasCoordinates = event.latitude != null && event.longitude != null;
  const Header = hasDescription ? Pressable : View;
  const open = (url: string) => {
    void openURL(url).catch(() => showErrorToast("Could not open link."));
  };
  return (
    <View
      style={{
        borderRadius: theme.radius.sm,
        backgroundColor: theme.colors.backgroundElement,
      }}
    >
      <Header
        accessibilityRole={hasDescription ? "button" : undefined}
        accessibilityLabel={
          hasDescription
            ? `${expanded ? "Hide" : "Show"} SPIN report for ${location}`
            : undefined
        }
        accessibilityState={hasDescription ? { expanded } : undefined}
        onPress={
          hasDescription ? () => setExpanded((value) => !value) : undefined
        }
        style={{
          padding: theme.spacing.md,
          paddingBottom: hasDescription ? theme.spacing.md : 0,
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.md,
        }}
      >
        {hasDescription && expanded && (
          <IconChevronUp size={14} color={theme.colors.textSecondary} />
        )}
        {hasDescription && !expanded && (
          <IconChevronDown size={14} color={theme.colors.textSecondary} />
        )}
        <Typography
          variant="bodySmall"
          numberOfLines={2}
          style={{ flex: 1, fontWeight: "400" }}
        >
          {location}
        </Typography>
        <Typography variant="caption" color={theme.colors.textSecondary}>
          {formatReceivedAt(event.eventAt)}
        </Typography>
      </Header>
      {hasDescription && expanded && (
        <View
          style={{
            paddingHorizontal: theme.spacing.md,
          }}
        >
          <Typography style={{ lineHeight: 23 }}>
            {event.description}
          </Typography>
        </View>
      )}
      {(!hasDescription || expanded) && (
        <View
          style={{
            paddingHorizontal: theme.spacing.md,
            paddingBottom: theme.spacing.sm,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${location}: open SPIN event`}
            onPress={() =>
              open(`https://spin3.sos112.si/javno/zemljevid/${event.id}`)
            }
            hitSlop={{ top: 6, bottom: 6 }}
            style={({ pressed }) => ({
              minWidth: 44,
              minHeight: 32,
              justifyContent: "center",
              opacity: pressed ? 0.55 : 1,
            })}
          >
            <Typography
              variant="bodySmall"
              style={{ fontWeight: "400", textDecorationLine: "underline" }}
            >
              SPIN
            </Typography>
          </Pressable>
          {hasCoordinates && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${location}: open approximate location`}
              onPress={() =>
                open(
                  `https://www.google.com/maps/search/?api=1&query=${event.latitude},${event.longitude}`,
                )
              }
              hitSlop={{ top: 6, bottom: 6 }}
              style={({ pressed }) => ({
                minWidth: 44,
                minHeight: 32,
                alignItems: "flex-end",
                justifyContent: "center",
                opacity: pressed ? 0.55 : 1,
              })}
            >
              <IconMapPin
                size={18}
                strokeWidth={1.8}
                color={theme.colors.text}
              />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
};
