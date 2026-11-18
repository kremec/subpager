import { type FC, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { router } from "expo-router";

import { type LegendListRef } from "@legendapp/list/react-native";

import { Icon, IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Screen } from "@/components/ui/screen";
import { useMessageHistory } from "@/pager/use-message-history";
import { MessageList } from "@/screens/history/components/message-list";
import { useTheme } from "@/theme/use-theme";

interface SearchScreenProps {
  spinPreview?: boolean;
}

export const SearchScreen: FC<SearchScreenProps> = (props) => {
  const { spinPreview } = props;
  const theme = useTheme();
  const { messages, loading } = useMessageHistory();
  const [query, setQuery] = useState("");
  const list = useRef<LegendListRef>(null);
  const changeQuery = (text: string) => {
    if (list.current && list.current.getState().scroll !== 0)
      void list.current.scrollToOffset({ offset: 0, animated: false });
    setQuery(text);
  };

  return (
    <Screen style={{ paddingHorizontal: 0, paddingTop: 0, gap: 0 }}>
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
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: theme.colors.backgroundElement,
            borderRadius: theme.radius.sm,
            paddingLeft: theme.spacing.md,
          }}
        >
          <TextInput
            accessibilityLabel="Search feed"
            placeholder="Search feed"
            placeholderTextColor={theme.colors.textSecondary}
            value={query}
            onChangeText={changeQuery}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={{
              flex: 1,
              color: theme.colors.text,
              fontSize: theme.typography.body.fontSize,
              paddingVertical: theme.spacing.sm,
            }}
          />
          {!!query && (
            <IconButton
              accessibilityLabel="Clear search"
              onPress={() => changeQuery("")}
              plain
              size={36}
            >
              <Icon
                name={IconName.CIRCLE_X}
                color={theme.colors.textSecondary}
                size={18}
              />
            </IconButton>
          )}
        </View>
        <IconButton
          accessibilityLabel="Close search"
          onPress={() => router.back()}
          plain
          style={({ pressed }) => ({
            opacity: pressed ? 0.45 : 1,
          })}
        >
          <Icon name={IconName.X} color={theme.colors.text} size={24} />
        </IconButton>
      </View>
      <MessageList
        messages={messages}
        loading={loading}
        query={query}
        spinPreview={spinPreview}
        listRef={list}
      />
    </Screen>
  );
};
