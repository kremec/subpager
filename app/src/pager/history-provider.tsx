import { type FC, type ReactNode, useEffect, useState } from "react";
import { AppState } from "react-native";

import { showErrorToast } from "@/components/ui/toast";
import { useConnection } from "@/pager/connection-provider";
import {
  cachedHistory,
  cachedSync,
  cacheMessages,
  cacheRicUnits,
} from "@/pager/database";
import { watchMessages, watchRicUnits } from "@/pager/firebase";
import type { CachedSync, PagerMessage } from "@/pager/types";
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
  const [syncVersion, setSyncVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const allowed = () => !cancelled && !!uid && hasAccess(uid);
    let saved: ReturnType<typeof cachedHistory> = null;
    let sync: CachedSync = {
      initialized: false,
      cursor: { seconds: 0, nanoseconds: 0 },
      ricRevision: null,
    };
    if (uid && hasAccess(uid)) {
      try {
        saved = cachedHistory(uid);
        sync = cachedSync(uid);
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
    let messagesAttached = false;
    let unitsAttached = false;
    let messageGeneration = 0;
    let unitGeneration = 0;
    const attachMessages = () => {
      messagesFailed = false;
      unsubscribeMessages();
      const generation = ++messageGeneration;
      messagesAttached = true;
      let first = true;
      unsubscribeMessages = watchMessages(
        sync,
        (next) => {
          if (!allowed() || generation !== messageGeneration) return false;
          setMessages((previous) => {
            const merged = new Map(
              (next.reset ? [] : previous).map((message) => [
                message.id,
                message,
              ]),
            );
            for (const id of next.removedIds) merged.delete(id);
            for (const message of next.messages)
              merged.set(message.id, message);
            return [...merged.values()].sort(
              (a, b) =>
                b.receivedAt.localeCompare(a.receivedAt) ||
                b.id.localeCompare(a.id),
            );
          });
          setLoading(false);
          if (first) {
            first = false;
            setSyncVersion((version) => version + 1);
          }
          try {
            if (!cacheMessages(uid, next.messages, next)) return false;
            sync = { ...sync, initialized: true, cursor: next.cursor };
            return true;
          } catch {
            showErrorToast("Could not save message history.");
            return false;
          }
        },
        (error) => {
          if (cancelled || generation !== messageGeneration) return;
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
      const generation = ++unitGeneration;
      unitsAttached = true;
      unsubscribeUnits = watchRicUnits(
        () => sync.ricRevision,
        (next, revision) => {
          if (!allowed() || generation !== unitGeneration) return;
          setUnitNames(new Map(next.map((unit) => [unit.ric, unit.unitName])));
          try {
            if (cacheRicUnits(uid, next, revision))
              sync = { ...sync, ricRevision: revision };
          } catch {
            showErrorToast("Could not save unit names.");
          }
        },
        (error) => {
          if (cancelled || generation !== unitGeneration) return;
          unitsFailed = true;
          if (!allowed()) return;
          showErrorToast(error.message);
        },
      );
    };
    if (AppState.currentState === "active") {
      attachMessages();
      attachUnits();
    }
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        ++messageGeneration;
        ++unitGeneration;
        if (messagesAttached) unsubscribeMessages();
        if (unitsAttached) unsubscribeUnits();
        messagesAttached = false;
        unitsAttached = false;
        unsubscribeMessages = () => {};
        unsubscribeUnits = () => {};
        return;
      }
      if (!allowed()) return;
      if (!messagesAttached || messagesFailed) attachMessages();
      if (!unitsAttached || unitsFailed) attachUnits();
    });
    return () => {
      cancelled = true;
      unsubscribeMessages();
      unsubscribeUnits();
      appState.remove();
    };
  }, [uid, hasAccess]);

  const visible = !!uid && historyUid === uid && hasAccess(uid);
  return (
    <HistoryContext.Provider
      value={{
        messages: visible ? messages : [],
        unitNames: visible ? unitNames : new Map(),
        loading: visible && loading,
        syncVersion,
      }}
    >
      {props.children}
    </HistoryContext.Provider>
  );
};
