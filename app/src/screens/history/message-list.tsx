import { type FC, type RefObject, useMemo } from "react";
import { View } from "react-native";

import { LegendList, type LegendListRef } from "@legendapp/list/react-native";

import { Typography } from "@/components/ui/typography";
import { previewSpinEvent } from "@/pager/spin-preview-data";
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
  spinPreview?: boolean;
  listRef?: RefObject<LegendListRef | null>;
  onScrollBeginDrag?: () => void;
}

export const MessageList: FC<MessageListProps> = (props) => {
  const {
    messages: receivedMessages,
    loading = false,
    query,
    spinPreview = false,
    listRef,
    onScrollBeginDrag,
  } = props;
  const theme = useTheme();
  const { unitNames, spinEvents: savedSpinEvents } = useMessageHistory();
  const { messages, spinEvents } = useMemo(() => {
    if (!__DEV__ || !spinPreview)
      return { messages: receivedMessages, spinEvents: savedSpinEvents };
    const events = new Map(savedSpinEvents);
    const messages = receivedMessages.map((message) => {
      if (message.spinEventId) return message;
      const event = previewSpinEvent(message);
      if (!event) return message;
      events.set(event.id, event);
      return { ...message, spinEventId: event.id };
    });
    return { messages, spinEvents: events };
  }, [receivedMessages, savedSpinEvents, spinPreview]);
  const searching = query !== undefined;
  const index = useMemo(
    () =>
      searching ? indexMessages(messages, unitNames, spinEvents) : undefined,
    [messages, unitNames, spinEvents, searching],
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
      extraData={{ unitNames, spinEvents, spinPreview }}
      keyExtractor={(message) => message.id}
      renderItem={({ item }) => (
        <MessageRow
          message={item}
          unitNames={unitNames}
          spinEvent={
            item.spinEventId ? spinEvents.get(item.spinEventId) : undefined
          }
        />
      )}
      maintainVisibleContentPosition={
        searching ? false : { data: true, size: false }
      }
      onScrollBeginDrag={onScrollBeginDrag}
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
