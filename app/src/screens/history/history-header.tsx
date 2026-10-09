import { type FC, useState } from "react";
import { View } from "react-native";

import { useRouter } from "expo-router";

import { IconDots, IconSearch } from "@tabler/icons-react-native";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { IconButton } from "@/components/ui/icon-button";
import { Typography } from "@/components/ui/typography";
import { SettingsScreen } from "@/screens/settings/settings-screen";
import { useTheme } from "@/theme/use-theme";

export const HistoryHeader: FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const [menuVisible, setMenuVisible] = useState(false);
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
        style={{ flex: 1, fontFamily: theme.fonts.rounded }}
      >
        subpager
      </Typography>
      <IconButton
        accessibilityLabel="Search feed"
        onPress={() => router.push("/search")}
        style={{ width: 36, height: 36 }}
      >
        <IconSearch color={theme.colors.text} size={22} strokeWidth={1.8} />
      </IconButton>
      <IconButton
        accessibilityLabel="Open settings"
        onPress={() => setMenuVisible(true)}
        style={{ width: 36, height: 36 }}
      >
        <IconDots color={theme.colors.text} size={22} strokeWidth={1.8} />
      </IconButton>
      <BottomSheet visible={menuVisible} onClose={() => setMenuVisible(false)}>
        <SettingsScreen />
      </BottomSheet>
    </View>
  );
};
