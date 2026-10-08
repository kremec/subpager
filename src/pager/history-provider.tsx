import {
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { AppState } from "react-native";

import { useConvexAuth } from "convex/react";

import { showErrorToast } from "@/components/ui/toast";
import { useConnection } from "@/pager/connection-provider";
import { watchMessages, watchRicUnits } from "@/pager/convex";
import {
  cachedMessages,
  cachedRicUnits,
  cacheMessages,
  cacheRicUnits,
  subscribeToMessages,
} from "@/pager/database";
import type { PagerMessage } from "@/pager/types";
import { HistoryContext } from "@/pager/use-message-history";

interface HistoryProviderProps {
  children: ReactNode;
}

export const HistoryProvider: FC<HistoryProviderProps> = (props) => {
  const { connection, hasAccess, ready } = useConnection();
  const { isAuthenticated } = useConvexAuth();
  const uid = ready ? connection?.uid : undefined;
  const [messages, setMessages] = useState<PagerMessage[]>([]);
  const [unitNames, setUnitNames] = useState<ReadonlyMap<number, string>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const allowed = () => !cancelled && !!uid && hasAccess(uid);
    const update = () => {
      try {
        const nextMessages = allowed() ? cachedMessages() : [];
        const nextUnitNames = allowed() ? cachedRicUnits() : new Map();
        setMessages(nextMessages);
        setUnitNames(nextUnitNames);
        return nextMessages.length;
      } catch {
        showErrorToast("Could not read saved history.");
        return null;
      }
    };
    // Read the external SQLite cache when access changes.
    const cachedCount = update();
    // Reset status while attaching listeners for the current device.
    /* oxlint-disable react/set-state-in-effect */
    setLoading(!!uid && isAuthenticated && cachedCount === 0);
    /* oxlint-enable react/set-state-in-effect */
    const unsubscribeCache = subscribeToMessages(update);
    if (!uid || !isAuthenticated) return unsubscribeCache;

    let messagesFailed = false;
    let unitsFailed = false;
    let unsubscribeMessages = () => {};
    let unsubscribeUnits = () => {};
    const attachMessages = () => {
      messagesFailed = false;
      unsubscribeMessages();
      unsubscribeMessages = watchMessages(
        (next) => {
          if (!allowed()) return;
          try {
            cacheMessages(next);
          } catch {
            showErrorToast("Could not save message history.");
          }
          setLoading(false);
        },
        (error) => {
          if (cancelled) return;
          messagesFailed = true;
          if (!allowed()) return;
          showErrorToast(error.message);
          setLoading(false);
        },
      );
    };
    const attachUnits = () => {
      unitsFailed = false;
      unsubscribeUnits();
      unsubscribeUnits = watchRicUnits(
        (next) => {
          if (!allowed()) return;
          try {
            cacheRicUnits(next);
          } catch {
            showErrorToast("Could not save unit names.");
          }
        },
        (error) => {
          if (cancelled) return;
          unitsFailed = true;
          if (!allowed()) return;
          showErrorToast(error.message);
        },
      );
    };
    attachMessages();
    attachUnits();
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !allowed()) return;
      if (messagesFailed) attachMessages();
      if (unitsFailed) attachUnits();
    });
    return () => {
      cancelled = true;
      unsubscribeCache();
      unsubscribeMessages();
      unsubscribeUnits();
      appState.remove();
    };
  }, [uid, hasAccess, isAuthenticated, attempt]);

  return (
    <HistoryContext.Provider
      value={{
        messages,
        unitNames,
        loading,
        refresh,
      }}
    >
      {props.children}
    </HistoryContext.Provider>
  );
};
