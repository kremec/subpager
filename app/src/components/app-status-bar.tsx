import { type FC } from "react";
import { StatusBar } from "react-native";

import { useTheme } from "@/theme/use-theme";

export const AppStatusBar: FC = () => {
  const theme = useTheme();

  return (
    <StatusBar
      animated
      barStyle={theme.themeName === "dark" ? "light-content" : "dark-content"}
    />
  );
};
