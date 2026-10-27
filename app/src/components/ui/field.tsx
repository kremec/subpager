import { type FC } from "react";
import { TextInput, View, type TextInputProps } from "react-native";

import { Typography } from "@/components/ui/typography";
import { useTheme } from "@/theme/use-theme";

interface FieldProps extends TextInputProps {
  label?: string;
}

export const Field: FC<FieldProps> = (props) => {
  const { label, style, ...textInputProps } = props;
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xs }}>
      {label && <Typography variant="bodySmall">{label}</Typography>}
      <TextInput
        placeholderTextColor={theme.colors.textSecondary}
        style={[
          {
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
            color: theme.colors.text,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.md,
            fontSize: theme.typography.body,
          },
          style,
        ]}
        {...textInputProps}
      />
    </View>
  );
};
