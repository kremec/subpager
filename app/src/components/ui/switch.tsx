import { type ComponentProps, type FC } from "react";
import { Switch as RNSwitch } from "react-native";

import { useTheme } from "@/theme/use-theme";

export const Switch: FC<ComponentProps<typeof RNSwitch>> = (props) => {
  const theme = useTheme();

  return (
    <RNSwitch
      trackColor={{
        false: theme.colors.backgroundSelected,
        true: theme.colors.accentSoft,
      }}
      thumbColor={props.value ? theme.colors.accent : theme.colors.surface}
      {...props}
    />
  );
};
