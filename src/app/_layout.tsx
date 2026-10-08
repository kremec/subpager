import { type FC } from "react";

import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppRoot } from "@/components/app-root";
import { Toast } from "@/components/ui/toast";
import { ConnectionProvider } from "@/pager/connection-provider";
import { HistoryProvider } from "@/pager/history-provider";
import { ThemeProvider } from "@/theme/provider";

const RootLayout: FC = () => (
  <SafeAreaProvider>
    <ThemeProvider>
      <ConnectionProvider>
        <HistoryProvider>
          <AppRoot />
        </HistoryProvider>
      </ConnectionProvider>
      <Toast />
    </ThemeProvider>
  </SafeAreaProvider>
);
export default RootLayout;
