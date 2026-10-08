import { type FC, type ReactNode, useEffect, useMemo } from "react";

import * as SecureStore from "expo-secure-store";

import { ConvexAuthProvider, type TokenStorage } from "@convex-dev/auth/react";

import { Screen } from "@/components/ui/screen";
import { showErrorToast } from "@/components/ui/toast";
import { Typography } from "@/components/ui/typography";
import { getConvex } from "@/pager/convex";

const storage: TokenStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: FC<AuthProviderProps> = (props) => {
  const result = useMemo(() => {
    try {
      return { client: getConvex(), error: null };
    } catch (error) {
      return {
        client: null,
        error:
          error instanceof Error ? error.message : "Connection unavailable.",
      };
    }
  }, []);
  useEffect(() => {
    if (result.error) showErrorToast(result.error);
  }, [result.error]);
  if (!result.client)
    return (
      <Screen>
        <Typography>
          Install a configured app to connect this device.
        </Typography>
      </Screen>
    );
  return (
    <ConvexAuthProvider
      client={result.client}
      storage={storage}
      shouldHandleCode={false}
    >
      {props.children}
    </ConvexAuthProvider>
  );
};
