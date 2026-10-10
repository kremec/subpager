import { type FC, useEffect, useRef } from "react";

import { type LegendListRef } from "@legendapp/list/react-native";

import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { useMessageHistory } from "@/pager/use-message-history";
import { HistoryHeader } from "@/screens/history/history-header";
import { MessageList } from "@/screens/history/message-list";

interface HistoryScreenProps {
  spinPreview?: boolean;
}

export const HistoryScreen: FC<HistoryScreenProps> = (props) => {
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
      <HistoryHeader spinPreview={props.spinPreview} />
      {props.spinPreview && (
        <Typography
          variant="caption"
          style={{ paddingHorizontal: 16, paddingBottom: 8 }}
        >
          SPIN preview · Verified reports stored locally
        </Typography>
      )}
      <MessageList
        messages={messages}
        loading={loading}
        spinPreview={props.spinPreview}
        listRef={list}
        onScrollBeginDrag={() => {
          preservePosition.current = true;
        }}
      />
    </Screen>
  );
};
