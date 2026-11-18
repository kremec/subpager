import { type FC } from "react";

import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppRoot } from "@/components/app-root";
import { AppStatusBar } from "@/components/app-status-bar";
import { Toast } from "@/components/ui/toast";
import { ConnectionProvider } from "@/pager/connection-provider";
import { HistoryProvider } from "@/pager/history-provider";

const RootLayout: FC = () => (
  <SafeAreaProvider>
    <AppStatusBar />
    <ConnectionProvider>
      <HistoryProvider>
        <AppRoot />
      </HistoryProvider>
    </ConnectionProvider>
    <Toast />
  </SafeAreaProvider>
);
export default RootLayout;
