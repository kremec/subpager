import { type FC, Fragment, useState } from "react";

import { router } from "expo-router";

import { Header } from "@/components/ui/header";
import { Icon, IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SettingsSheet } from "@/screens/settings/settings-sheet";
import { useTheme } from "@/theme/use-theme";

interface HistoryHeaderProps {
  spinPreview?: boolean;
}

export const HistoryHeader: FC<HistoryHeaderProps> = (props) => {
  const { spinPreview } = props;
  const theme = useTheme();
  const [menuVisible, setMenuVisible] = useState(false);
  return (
    <Fragment>
      <Header title="subpager">
        <IconButton
          accessibilityLabel="Search feed"
          onPress={() =>
            router.push(
              spinPreview
                ? { pathname: "/search", params: { spinPreview: "1" } }
                : "/search",
            )
          }
          size={36}
        >
          <Icon name={IconName.SEARCH} color={theme.colors.text} size={22} />
        </IconButton>
        <IconButton
          accessibilityLabel="Open settings"
          onPress={() => setMenuVisible(true)}
          size={36}
        >
          <Icon name={IconName.DOTS} color={theme.colors.text} size={22} />
        </IconButton>
      </Header>
      <SettingsSheet
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
      />
    </Fragment>
  );
};
