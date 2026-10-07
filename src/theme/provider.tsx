import { createContext, type FC, type ReactNode, useContext } from "react";
import { useColorScheme } from "react-native";

import { palette, type ThemeColors, type ThemeName } from "@/theme/palette";
import { fonts, layout, radius, spacing, typography } from "@/theme/tokens";

interface ThemeContextValue {
  themeName: ThemeName;
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  fonts: typeof fonts;
  layout: typeof layout;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeName: "light",
  colors: palette.light,
  spacing,
  radius,
  typography,
  fonts,
  layout,
});

interface ThemeProviderProps {
  children?: ReactNode;
}

export const ThemeProvider: FC<ThemeProviderProps> = (props) => {
  const { children } = props;
  const scheme = useColorScheme();
  const themeName: ThemeName = scheme === "dark" ? "dark" : "light";
  const value: ThemeContextValue = {
    themeName,
    colors: palette[themeName],
    spacing,
    radius,
    typography,
    fonts,
    layout,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export function useThemeContext(): ThemeContextValue {
  return useContext(ThemeContext);
}
