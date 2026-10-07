import { type FC } from "react";
import { Pressable } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}
export const Button: FC<ButtonProps> = (props) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.sm,
        backgroundColor: theme.colors.accentSoft,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Typography color={theme.colors.accent} style={{ textAlign: "center" }}>
        {props.label}
      </Typography>
    </Pressable>
  );
};
