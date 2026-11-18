import { type TextStyle } from "react-native";

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
  body: { fontSize: 16, lineHeight: 22, fontWeight: "400" },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  bodySmall: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "400",
  },
  bodySmallSemibold: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  titleSmallRegular: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "400",
  },
} satisfies Record<string, TextStyle>;
