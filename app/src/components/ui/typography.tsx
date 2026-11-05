import { type FC } from "react";
import { Platform, Text, type TextProps, type TextStyle } from "react-native";

import { typography } from "@/theme/tokens";
import { useTheme } from "@/theme/use-theme";

export const typographyStyles = {
  display: { fontSize: typography.display, lineHeight: 38, fontWeight: "700" },
  title: { fontSize: typography.title, lineHeight: 28, fontWeight: "700" },
  titleSmall: {
    fontSize: typography.titleSmall,
    lineHeight: 22,
    fontWeight: "600",
  },
  body: { fontSize: typography.body, lineHeight: 22 },
  bodySemibold: {
    fontSize: typography.body,
    lineHeight: 22,
    fontWeight: "600",
  },
  bodyStrong: { fontSize: typography.body, lineHeight: 22, fontWeight: "700" },
  bodySmall: {
    fontSize: typography.bodySmall,
    lineHeight: 18,
    fontWeight: "500",
  },
  bodySmallRegular: {
    fontSize: typography.bodySmall,
    lineHeight: 18,
    fontWeight: "400",
  },
  bodySmallSemibold: {
    fontSize: typography.bodySmall,
    lineHeight: 18,
    fontWeight: "600",
  },
  caption: { fontSize: typography.caption, lineHeight: 16, fontWeight: "500" },
  captionSemibold: {
    fontSize: typography.caption,
    lineHeight: 16,
    fontWeight: "600",
  },
  titleSmallRegular: {
    fontSize: typography.titleSmall,
    lineHeight: 24,
    fontWeight: "400",
  },
  bodyRegular: { fontSize: typography.body, lineHeight: 23, fontWeight: "400" },
  bodySmallRelaxed: {
    fontSize: typography.bodySmall,
    lineHeight: 20,
    fontWeight: "400",
  },
  mono: {
    fontSize: typography.bodySmall,
    lineHeight: 18,
    fontWeight: "400",
    fontFamily: Platform.select({ ios: "ui-monospace", default: "monospace" }),
  },
} satisfies Record<string, TextStyle>;

interface TypographyProps extends TextProps {
  variant?: keyof typeof typographyStyles;
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
          fontWeight: theme.typography.bodyWeight,
        },
        typographyStyles[variant],
        style,
      ]}
      {...textProps}
    />
  );
};
