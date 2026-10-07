import { type FC } from "react";

import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppRoot } from "@/components/app-root";
import { ConnectionProvider } from "@/pager/connection-provider";
import { ThemeProvider } from "@/theme/provider";

const RootLayout: FC = () => (
  <SafeAreaProvider>
    <ThemeProvider>
      <ConnectionProvider>
        <AppRoot />
      </ConnectionProvider>
    </ThemeProvider>
  </SafeAreaProvider>
);
export default RootLayout;
