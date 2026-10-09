import { type FC } from "react";

import { Screen } from "@/components/ui/screen";
import { useMessageHistory } from "@/pager/use-message-history";
import { HistoryHeader } from "@/screens/history/history-header";
import { MessageList } from "@/screens/history/message-list";

export const HistoryScreen: FC = () => {
  const { messages, loading } = useMessageHistory();
  return (
    <Screen headerShown={false} style={{ padding: 0, gap: 0 }}>
      <HistoryHeader />
      <MessageList messages={messages} loading={loading} />
    </Screen>
  );
};
