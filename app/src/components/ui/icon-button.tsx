import { type FC } from "react";
import { Pressable, type PressableProps } from "react-native";

import { useTheme } from "@/theme/use-theme";

interface IconButtonProps extends PressableProps {
  plain?: boolean;
  size?: number;
}

export const IconButton: FC<IconButtonProps> = (props) => {
  const {
    children,
    disabled,
    plain,
    size = 42,
    style,
    ...pressableProps
  } = props;
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      {...pressableProps}
      style={(state) => [
        {
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.full,
          borderWidth: plain ? 0 : 1,
          borderColor: theme.colors.border,
          width: size,
          height: size,
          backgroundColor: plain ? "transparent" : theme.colors.surface,
          opacity: state.pressed ? 0.55 : 1,
        },
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {children}
    </Pressable>
  );
};
