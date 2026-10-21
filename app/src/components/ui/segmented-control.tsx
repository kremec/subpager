import { type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

export interface SegmentedControlItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  items: SegmentedControlItem<T>[];
  value: T;
  onChange: (value: T) => void;
}

export const SegmentedControl = <T extends string>(
  props: SegmentedControlProps<T>,
) => {
  const { items, value, onChange } = props;
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: "row",
        gap: theme.spacing.xs,
        padding: theme.spacing.xs,
        borderRadius: theme.radius.full,
        backgroundColor: theme.colors.backgroundElement,
      }}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <Pressable
            key={item.value}
            onPress={() => onChange(item.value)}
            style={{
              flex: 1,
              borderRadius: theme.radius.full,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              backgroundColor: selected ? theme.colors.surface : "transparent",
            }}
          >
            <View
              style={{
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                gap: theme.spacing.xs,
              }}
            >
              {item.icon}
              <Typography variant="bodySmall">{item.label}</Typography>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
};
