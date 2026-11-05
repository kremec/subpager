import { type FC, type PropsWithChildren } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";

import { Card } from "@/components/ui/card";
import { useTheme } from "@/theme/use-theme";

interface DialogProps {
  visible: boolean;
  onClose: () => void;
}

export const Dialog: FC<PropsWithChildren<DialogProps>> = (props) => {
  const { visible, onClose, children } = props;
  const theme = useTheme();

  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          flex: 1,
          justifyContent: "center",
          padding: theme.spacing.xl,
          backgroundColor: "rgba(0,0,0,0.45)",
        }}
      >
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
        <Card style={{ width: "100%", maxHeight: "88%" }}>
          <ScrollView
            style={{ flexGrow: 0 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Card>
      </KeyboardAvoidingView>
    </Modal>
  );
};
