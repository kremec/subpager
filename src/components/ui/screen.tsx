import { type FC, type PropsWithChildren } from "react";
import { ScrollView, type StyleProp, View, type ViewStyle } from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/theme/use-theme";

interface ScreenProps {
  scroll?: boolean;
  headerShown?: boolean;
  style?: StyleProp<ViewStyle>;
}
export const Screen: FC<PropsWithChildren<ScreenProps>> = (props) => {
  const { children, scroll = false, headerShown = true, style } = props;
  const theme = useTheme();
  const contentStyle = {
    width: "100%" as const,
    maxWidth: theme.layout.screenMaxWidth,
    alignSelf: "center" as const,
    padding: theme.spacing.lg,
    gap: theme.spacing.lg,
  };
  return (
    <SafeAreaView
      edges={headerShown ? ["left", "right", "bottom"] : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={[contentStyle, style]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[contentStyle, { flex: 1 }, style]}>{children}</View>
      )}
    </SafeAreaView>
  );
};
