import { Platform, type TextStyle } from "react-native";

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  full: 999,
} as const;

export const typography = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700" },
  title: { fontSize: 24, lineHeight: 28, fontWeight: "700" },
  titleSmall: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "600",
  },
  body: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
  bodySemibold: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  bodySmall: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "500",
  },
  bodySmallRegular: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "400",
  },
  bodySmallSemibold: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
  },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  captionSemibold: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  titleSmallRegular: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "400",
  },
  bodyRegular: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
  bodySmallRelaxed: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "400",
  },
  mono: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "400",
    fontFamily: Platform.select({ ios: "ui-monospace", default: "monospace" }),
  },
} satisfies Record<string, TextStyle>;

export const fonts = Platform.select({
  ios: {
    sans: "system-ui",
    serif: "ui-serif",
    rounded: "ui-rounded",
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
});

export const layout = {
  screenMaxWidth: 820,
  bottomInset: 0,
} as const;
