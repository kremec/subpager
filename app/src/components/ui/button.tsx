import { type FC, type ReactNode } from "react";
import { Pressable, type PressableProps, View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

type ButtonVariant = "solid" | "outline" | "ghost";

interface ButtonProps extends Omit<PressableProps, "children"> {
  children: string;
  variant?: ButtonVariant;
  leftAccessory?: ReactNode;
}

export const Button: FC<ButtonProps> = (props) => {
  const {
    children,
    onPress,
    variant = "solid",
    disabled,
    leftAccessory,
    style,
    ...pressableProps
  } = props;
  const theme = useTheme();
  const colors = {
    solid: {
      background: theme.colors.accent,
      border: theme.colors.accent,
      text: theme.colors.surface,
    },
    outline: {
      background: "transparent",
      border: theme.colors.border,
      text: theme.colors.text,
    },
    ghost: {
      background: "transparent",
      border: "transparent",
      text: theme.colors.text,
    },
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      {...pressableProps}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        {
          borderRadius: theme.radius.full,
          backgroundColor: colors.background,
          borderColor: colors.border,
          borderWidth: variant === "ghost" ? 0 : 1,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          opacity: disabled ? 0.45 : 1,
        },
        typeof style === "function" ? style(state) : style,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: theme.spacing.sm,
        }}
      >
        {leftAccessory}
        <Typography variant="bodyStrong" color={colors.text}>
          {children}
        </Typography>
      </View>
    </Pressable>
  );
};
