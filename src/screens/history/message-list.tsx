import { type FC, type RefObject, useMemo } from "react";
import { View } from "react-native";

import { LegendList, type LegendListRef } from "@legendapp/list/react-native";

import { Typography } from "@/components/ui/typography";
import type { PagerMessage } from "@/pager/types";
import { useMessageHistory } from "@/pager/use-message-history";
import { MessageRow } from "@/screens/history/message-row";
import {
  indexMessages,
  searchMessages,
} from "@/screens/history/search-messages";
import { useTheme } from "@/theme/use-theme";

interface MessageListProps {
  messages: PagerMessage[];
  loading?: boolean;
  query?: string;
  listRef?: RefObject<LegendListRef | null>;
}

export const MessageList: FC<MessageListProps> = (props) => {
  const { messages, loading = false, query, listRef } = props;
  const theme = useTheme();
  const { unitNames } = useMessageHistory();
  const searching = query !== undefined;
  const index = useMemo(
    () => (searching ? indexMessages(messages, unitNames) : undefined),
    [messages, unitNames, searching],
  );
  const filtered = useMemo(
    () => (index && query?.trim() ? searchMessages(index, query) : messages),
    [messages, index, query],
  );
  let emptyMessage = "No messages yet.";
  if (loading) emptyMessage = "Loading messages…";
  if (query?.trim()) emptyMessage = "No matching messages";

  return (
    <LegendList
      ref={listRef}
      style={{ flex: 1 }}
      data={filtered}
      recycleItems
      extraData={unitNames}
      keyExtractor={(message) => message.id}
      renderItem={({ item }) => (
        <MessageRow message={item} unitName={unitNames.get(item.ric)} />
      )}
      maintainVisibleContentPosition={searching ? false : { data: true }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator
      indicatorStyle={theme.themeName === "dark" ? "white" : "black"}
      contentContainerStyle={{ flexGrow: 1 }}
      ListEmptyComponent={
        <View
          style={{
            flex: searching ? 1 : undefined,
            padding: theme.spacing.lg,
            alignItems: searching ? "center" : undefined,
            justifyContent: searching ? "center" : undefined,
          }}
        >
          <Typography color={theme.colors.textSecondary}>
            {emptyMessage}
          </Typography>
        </View>
      }
    />
  );
};
