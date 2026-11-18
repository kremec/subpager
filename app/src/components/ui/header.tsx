import { type FC, type ReactNode } from "react";
import { View } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

interface HeaderProps {
  title: string;
  center?: ReactNode;
  children?: ReactNode;
}

export const Header: FC<HeaderProps> = (props) => {
  const { title, center, children } = props;
  const theme = useTheme();

  return (
    <View
      style={{
        minHeight: 64,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Typography
        variant="title"
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={1.5}
        style={{ flexShrink: 1 }}
      >
        {title}
      </Typography>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {center}
      </View>
      {children}
    </View>
  );
};
