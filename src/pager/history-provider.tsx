import {
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { AppState } from "react-native";

import { showErrorToast } from "@/components/ui/toast";
import { useConnection } from "@/pager/connection-provider";
import { cachedHistory, cacheMessages, cacheRicUnits } from "@/pager/database";
import { watchMessages, watchRicUnits } from "@/pager/firebase";
import type { PagerMessage } from "@/pager/types";
import { HistoryContext } from "@/pager/use-message-history";

interface HistoryProviderProps {
  children: ReactNode;
}

export const HistoryProvider: FC<HistoryProviderProps> = (props) => {
  const { connection, hasAccess } = useConnection();
  const uid = connection?.uid;
  const [historyUid, setHistoryUid] = useState<string>();
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
    let saved: ReturnType<typeof cachedHistory> = null;
    if (uid && hasAccess(uid)) {
      try {
        saved = cachedHistory(uid);
      } catch {
        showErrorToast("Could not read saved history.");
      }
    }
    /* oxlint-disable react/set-state-in-effect */
    setHistoryUid(uid);
    setMessages(saved?.messages ?? []);
    setUnitNames(
      new Map(saved?.units.map((unit) => [unit.ric, unit.unitName])),
    );
    setLoading(!!uid && !saved?.messages.length);
    /* oxlint-enable react/set-state-in-effect */
    if (!uid) return;

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
          setMessages(next);
          setLoading(false);
          try {
            cacheMessages(uid, next);
          } catch {
            showErrorToast("Could not save message history.");
          }
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
          setUnitNames(new Map(next.map((unit) => [unit.ric, unit.unitName])));
          try {
            cacheRicUnits(uid, next);
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
      unsubscribeMessages();
      unsubscribeUnits();
      appState.remove();
    };
  }, [uid, hasAccess, attempt]);

  const visible = !!uid && historyUid === uid && hasAccess(uid);
  return (
    <HistoryContext.Provider
      value={{
        messages: visible ? messages : [],
        unitNames: visible ? unitNames : new Map(),
        loading: visible && loading,
        refresh,
      }}
    >
      {props.children}
    </HistoryContext.Provider>
  );
};
