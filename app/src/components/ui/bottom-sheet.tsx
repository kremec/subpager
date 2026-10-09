import { type FC, type PropsWithChildren } from "react";
import { useWindowDimensions } from "react-native";

import {
  BottomSheet as NativeBottomSheet,
  BottomSheetScrollView,
} from "@expo/ui/community/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Toast } from "@/components/ui/toast";
import { useTheme } from "@/theme/use-theme";

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
}

export const BottomSheet: FC<PropsWithChildren<BottomSheetProps>> = (props) => {
  const { children, visible, onClose } = props;
  const { colors, spacing } = useTheme();
  const { height, width } = useWindowDimensions();
  const { top } = useSafeAreaInsets();

  return (
    <NativeBottomSheet
      index={visible ? 0 : -1}
      backgroundStyle={{ backgroundColor: colors.surface }}
      enablePanDownToClose
      onClose={onClose}
    >
      <BottomSheetScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ width, maxHeight: height - top - spacing.xxxl - spacing.lg }}
      >
        {children}
      </BottomSheetScrollView>
      {visible && <Toast topOffset={0} />}
    </NativeBottomSheet>
  );
};
