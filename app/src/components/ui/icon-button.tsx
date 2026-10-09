import { type FC, type PropsWithChildren } from "react";
import { Pressable, type PressableProps } from "react-native";

import { useTheme } from "@/theme/use-theme";

interface IconButtonProps {
  accessibilityLabel?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  style?: PressableProps["style"];
}

export const IconButton: FC<PropsWithChildren<IconButtonProps>> = (props) => {
  const { children, onPress, onLongPress, disabled, style } = props;
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      style={(state) => [
        {
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.full,
          borderWidth: 1,
          borderColor: theme.colors.border,
          width: 42,
          height: 42,
          backgroundColor: theme.colors.surface,
          opacity: state.pressed ? 0.55 : 1,
        },
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {children}
    </Pressable>
  );
};
