import { type FC } from "react";

import { Screen } from "@/components/ui/screen";
import { useConnection } from "@/pager/connection-provider";
import { useMessageHistory } from "@/pager/use-message-history";
import { HistoryHeader } from "@/screens/history/history-header";
import { MessageList } from "@/screens/history/message-list";

export const HistoryScreen: FC = () => {
  const { error: accessError, retry } = useConnection();
  const { messages, loading, refresh } = useMessageHistory();
  return (
    <Screen headerShown={false} style={{ padding: 0, gap: 0 }}>
      <HistoryHeader />
      <MessageList
        messages={messages}
        loading={loading}
        onRefresh={accessError ? retry : refresh}
      />
    </Screen>
  );
};
