export const palette = {
  light: {
    background: "#F7F7F5",
    backgroundElement: "#EFEFEC",
    backgroundSelected: "#E4E4DF",
    surface: "#FFFFFF",
    text: "#181817",
    textSecondary: "#777773",
    border: "#E6E6E1",
    accent: "#5B4FE9",
    accentSoft: "#EEECFD",
    danger: "#C43D2B",
    errorSurface: "#FAE8E6",
    success: "#2E8B57",
    warning: "#C58B16",
  },
  dark: {
    background: "#111110",
    backgroundElement: "#20201E",
    backgroundSelected: "#292926",
    surface: "#191918",
    text: "#F4F4F1",
    textSecondary: "#A2A29C",
    border: "#343431",
    accent: "#A69FFF",
    accentSoft: "#302B50",
    danger: "#FF9A8C",
    errorSurface: "#3A201F",
    success: "#65CF91",
    warning: "#EDBD59",
  },
} as const;

export type ThemeName = keyof typeof palette;
export type ThemeColors = (typeof palette)[ThemeName];
