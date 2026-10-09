import { type FC, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { type LegendListRef } from "@legendapp/list/react-native";

import { Screen } from "@/components/ui/screen";
import { useMessageHistory } from "@/pager/use-message-history";
import { HistoryHeader } from "@/screens/history/history-header";
import { MessageList } from "@/screens/history/message-list";

export const HistoryScreen: FC = () => {
  const { messages, loading, syncVersion } = useMessageHistory();
  const list = useRef<LegendListRef>(null);
  const interacted = useRef(false);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previousState === "background") {
        interacted.current = false;
        void list.current?.scrollToOffset({ offset: 0, animated: false });
      }
      // iOS passes through inactive when returning from the background.
      if (state !== "inactive") previousState = state;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    // Keep fresh opens at the top after missed messages have been loaded.
    if (!interacted.current)
      void list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [syncVersion]);
  return (
    <Screen headerShown={false} style={{ padding: 0, gap: 0 }}>
      <HistoryHeader />
      <MessageList
        messages={messages}
        loading={loading}
        listRef={list}
        onScrollBeginDrag={() => {
          interacted.current = true;
        }}
      />
    </Screen>
  );
};
