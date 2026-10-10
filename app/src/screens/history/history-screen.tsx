import { type FC, useEffect, useRef } from "react";

import { type LegendListRef } from "@legendapp/list/react-native";

import { Screen } from "@/components/ui/screen";
import { useMessageHistory } from "@/pager/use-message-history";
import { HistoryHeader } from "@/screens/history/history-header";
import { MessageList } from "@/screens/history/message-list";

export const HistoryScreen: FC = () => {
  const { messages, loading, syncVersion } = useMessageHistory();
  const list = useRef<LegendListRef>(null);
  const preservePosition = useRef(false);

  useEffect(() => {
    // Stay at the top through the initial sync, then preserve the reading position.
    if (!preservePosition.current)
      void list.current?.scrollToOffset({ offset: 0, animated: false });
    if (syncVersion > 0) preservePosition.current = true;
  }, [syncVersion]);
  return (
    <Screen headerShown={false} style={{ padding: 0, gap: 0 }}>
      <HistoryHeader />
      <MessageList
        messages={messages}
        loading={loading}
        listRef={list}
        onScrollBeginDrag={() => {
          preservePosition.current = true;
        }}
      />
    </Screen>
  );
};
