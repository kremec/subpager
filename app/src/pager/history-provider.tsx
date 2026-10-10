import { type FC, type ReactNode, useEffect, useState } from "react";
import { AppState } from "react-native";

import { showErrorToast } from "@/components/ui/toast";
import { useConnection } from "@/pager/connection-provider";
import {
  cachedHistory,
  cachedSpinEvents,
  cachedSync,
  cacheMessages,
  cacheRicUnits,
  cacheSpinEvent,
} from "@/pager/database";
import { watchMessages, watchRicUnits, watchSpinEvent } from "@/pager/firebase";
import type { CachedSync, PagerMessage, SpinEvent } from "@/pager/types";
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
  const [spinEvents, setSpinEvents] = useState<ReadonlyMap<string, SpinEvent>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const allowed = () => !cancelled && !!uid && hasAccess(uid);
    let saved: ReturnType<typeof cachedHistory> = null;
    let savedSpinEvents: SpinEvent[] = [];
    let sync: CachedSync = {
      initialized: false,
      cursor: { seconds: 0, nanoseconds: 0 },
    };
    if (uid && hasAccess(uid)) {
      try {
        saved = cachedHistory(uid);
        savedSpinEvents = cachedSpinEvents(uid);
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
    setSpinEvents(new Map(savedSpinEvents.map((event) => [event.id, event])));
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
    let active = AppState.currentState === "active";
    const currentMessages = new Map(
      saved?.messages.map((message) => [message.id, message]),
    );
    const spinSubscriptions = new Map<
      string,
      { unsubscribe: () => void; failed: boolean }
    >();
    const attachSpinEvents = () => {
      const ids = new Set(
        [...currentMessages.values()].flatMap((message) =>
          message.spinEventId ? [message.spinEventId] : [],
        ),
      );
      for (const [id, subscription] of spinSubscriptions) {
        if (!ids.has(id) || subscription.failed) {
          subscription.unsubscribe();
          spinSubscriptions.delete(id);
        }
      }
      if (!active || !allowed()) return;
      for (const id of ids) {
        if (spinSubscriptions.has(id)) continue;
        const subscription = { unsubscribe: () => {}, failed: false };
        spinSubscriptions.set(id, subscription);
        subscription.unsubscribe = watchSpinEvent(
          id,
          (event) => {
            if (
              !allowed() ||
              !active ||
              spinSubscriptions.get(id) !== subscription
            )
              return;
            setSpinEvents((previous) => {
              const next = new Map(previous);
              if (event) next.set(id, event);
              else next.delete(id);
              return next;
            });
            try {
              cacheSpinEvent(uid, id, event);
            } catch {
              showErrorToast("Could not save SPIN report.");
            }
          },
          (error) => {
            if (
              !allowed() ||
              !active ||
              spinSubscriptions.get(id) !== subscription
            )
              return;
            subscription.failed = true;
            showErrorToast(error.message);
          },
        );
      }
    };
    const detachSpinEvents = () => {
      for (const subscription of spinSubscriptions.values())
        subscription.unsubscribe();
      spinSubscriptions.clear();
    };
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
          if (next.reset) currentMessages.clear();
          for (const id of next.removedIds) currentMessages.delete(id);
          for (const message of next.messages)
            currentMessages.set(message.id, message);
          setMessages(
            [...currentMessages.values()].sort(
              (a, b) =>
                b.receivedAt.localeCompare(a.receivedAt) ||
                b.id.localeCompare(a.id),
            ),
          );
          attachSpinEvents();
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
        (next) => {
          if (!allowed() || generation !== unitGeneration) return;
          setUnitNames(new Map(next.map((unit) => [unit.ric, unit.unitName])));
          try {
            cacheRicUnits(uid, next);
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
      attachSpinEvents();
    }
    const appState = AppState.addEventListener("change", (state) => {
      active = state === "active";
      if (state !== "active") {
        ++messageGeneration;
        ++unitGeneration;
        if (messagesAttached) unsubscribeMessages();
        if (unitsAttached) unsubscribeUnits();
        messagesAttached = false;
        unitsAttached = false;
        unsubscribeMessages = () => {};
        unsubscribeUnits = () => {};
        detachSpinEvents();
        return;
      }
      if (!allowed()) return;
      if (!messagesAttached || messagesFailed) attachMessages();
      if (!unitsAttached || unitsFailed) attachUnits();
      attachSpinEvents();
    });
    return () => {
      cancelled = true;
      unsubscribeMessages();
      unsubscribeUnits();
      detachSpinEvents();
      appState.remove();
    };
  }, [uid, hasAccess]);

  const visible = !!uid && historyUid === uid && hasAccess(uid);
  return (
    <HistoryContext.Provider
      value={{
        messages: visible ? messages : [],
        unitNames: visible ? unitNames : new Map(),
        spinEvents: visible ? spinEvents : new Map(),
        loading: visible && loading,
        syncVersion,
      }}
    >
      {props.children}
    </HistoryContext.Provider>
  );
};
