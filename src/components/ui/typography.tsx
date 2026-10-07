import { type FC } from "react";
import { Text, type TextProps } from "react-native";

import { useTheme } from "@/theme/use-theme";

type Variant =
  | "display"
  | "title"
  | "titleSmall"
  | "body"
  | "bodyStrong"
  | "bodySmall"
  | "caption"
  | "mono";

interface TypographyProps extends TextProps {
  variant?: Variant;
  color?: string;
}

export const Typography: FC<TypographyProps> = (props) => {
  const { variant = "body", color, style, ...textProps } = props;
  const theme = useTheme();

  const variantStyle = (() => {
    switch (variant) {
      case "display":
        return {
          fontSize: theme.typography.display,
          lineHeight: theme.typography.display + 6,
          fontWeight: "700" as const,
        };
      case "title":
        return {
          fontSize: theme.typography.title,
          lineHeight: theme.typography.title + 4,
          fontWeight: "700" as const,
        };
      case "titleSmall":
        return {
          fontSize: theme.typography.titleSmall,
          lineHeight: theme.typography.titleSmall + 4,
          fontWeight: "600" as const,
        };
      case "bodyStrong":
        return {
          fontSize: theme.typography.body,
          lineHeight: theme.typography.body + 6,
          fontWeight: "700" as const,
        };
      case "bodySmall":
        return {
          fontSize: theme.typography.bodySmall,
          lineHeight: theme.typography.bodySmall + 4,
          fontWeight: "500" as const,
        };
      case "caption":
        return {
          fontSize: theme.typography.caption,
          lineHeight: theme.typography.caption + 4,
          fontWeight: "500" as const,
        };
      case "mono":
        return {
          fontSize: theme.typography.bodySmall,
          lineHeight: theme.typography.bodySmall + 4,
          fontFamily: theme.fonts?.mono,
        };
      default:
        return {
          fontSize: theme.typography.body,
          lineHeight: theme.typography.body + 6,
          fontWeight: "500" as const,
        };
    }
  })();

  return (
    <Text
      style={[
        {
          color: color ?? theme.colors.text,
        },
        variantStyle,
        style,
      ]}
      {...textProps}
    />
  );
};
