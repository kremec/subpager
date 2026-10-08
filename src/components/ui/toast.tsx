import { type FC } from "react";
import { Pressable, Text } from "react-native";

import ToastMessage, { type ToastConfig } from "react-native-toast-message";

import { useTheme } from "@/theme/use-theme";

export const showErrorToast = (message: string): void => {
  ToastMessage.show({
    type: "error",
    text1: "Couldn’t complete that",
    text2: message,
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
      const { onPress, text1, text2 } = params;
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${text1}. ${text2}. Dismiss`}
          onPress={onPress}
          style={{
            width: "92%",
            maxWidth: 420,
            borderRadius: 14,
            backgroundColor: colors.errorSurface,
            gap: 4,
            padding: 14,
          }}
        >
          <Text style={{ color: colors.danger, fontWeight: "600" }}>
            {text1}
          </Text>
          <Text
            accessibilityRole="alert"
            style={{ color: colors.text, lineHeight: 20 }}
          >
            {text2}
          </Text>
        </Pressable>
      );
    },
  };

  return <ToastMessage config={config} topOffset={topOffset} />;
};
