import { useColorScheme } from "react-native";

import { themePalettes } from "@/theme/palette";
import { radius, spacing, typography } from "@/theme/tokens";

const themes = {
  light: {
    themeName: "light",
    colors: themePalettes.light,
    spacing,
    typography,
    radius,
  },
  dark: {
    themeName: "dark",
    colors: themePalettes.dark,
    spacing,
    typography,
    radius,
  },
} as const;

export function useTheme() {
  const scheme = useColorScheme();
  return themes[scheme === "dark" ? "dark" : "light"];
}
