import { type FC } from "react";
import { View, type ViewProps } from "react-native";

import { useTheme } from "@/theme/use-theme";

export const Card: FC<ViewProps> = (props) => {
  const { style, ...viewProps } = props;
  const theme = useTheme();

  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radius.lg,
          padding: theme.spacing.lg,
          shadowColor: "#000000",
          shadowOpacity: 0.08,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 1,
        },
        style,
      ]}
      {...viewProps}
    />
  );
};
