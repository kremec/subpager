import { type FC, type PropsWithChildren } from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

interface ModalHeaderProps {
  title?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  onClose: () => void;
}

export const ModalHeader: FC<PropsWithChildren<ModalHeaderProps>> = (props) => {
  const {
    children,
    title,
    closeLabel = "Close",
    closeDisabled,
    onClose,
  } = props;
  const theme = useTheme();

  return (
    <View
      style={{
        height: 56,
        paddingHorizontal: theme.spacing.md,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {!!title && (
        <Typography style={{ flex: 1, fontWeight: "600" }}>{title}</Typography>
      )}
      {children}
      <IconButton
        plain
        accessibilityLabel={closeLabel}
        disabled={closeDisabled}
        onPress={onClose}
      >
        <Icon name="x" color={theme.colors.text} size={24} />
      </IconButton>
    </View>
  );
};
