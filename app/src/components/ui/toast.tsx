import { type FC } from "react";
import { Pressable } from "react-native";

import ToastMessage, { type ToastConfig } from "react-native-toast-message";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

export const showErrorToast = (message: string): void => {
  ToastMessage.show({
    type: "error",
    text1: message,
    onPress: ToastMessage.hide,
  });
};

interface ToastProps {
  topOffset?: number;
}

export const Toast: FC<ToastProps> = (props) => {
  const { topOffset = 56 } = props;
  const { colors } = useTheme();
  const config: ToastConfig = {
    error: (params) => {
      const { onPress, text1 } = params;
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text1}
          onPress={onPress}
          style={{
            width: "92%",
            maxWidth: 420,
            borderRadius: 14,
            backgroundColor: colors.errorSurface,
            padding: 14,
          }}
        >
          <Typography variant="bodySmallRelaxed" accessibilityRole="alert">
            {text1}
          </Typography>
        </Pressable>
      );
    },
  };

  return <ToastMessage config={config} topOffset={topOffset} />;
};
