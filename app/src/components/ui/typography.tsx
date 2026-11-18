import { type FC } from "react";
import { Text, type TextProps } from "react-native";

import { type typography } from "@/theme/tokens";
import { useTheme } from "@/theme/use-theme";

interface TypographyProps extends TextProps {
  variant?: keyof typeof typography;
  color?: string;
}

export const Typography: FC<TypographyProps> = (props) => {
  const { variant = "body", color, style, ...textProps } = props;
  const theme = useTheme();

  return (
    <Text
      style={[
        {
          color: color ?? theme.colors.text,
        },
        theme.typography[variant],
        // Native lineHeight keeps scaling after maxFontSizeMultiplier caps the font.
        textProps.maxFontSizeMultiplier !== undefined && {
          lineHeight: undefined,
        },
        style,
      ]}
      {...textProps}
    />
  );
};
