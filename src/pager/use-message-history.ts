import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { useConnection } from "@/pager/connection-provider";
import { cachedMessages, cacheMessages } from "@/pager/database";
import { getMessagePage } from "@/pager/firebase";
import { loadHistoryPage } from "@/pager/history-backfill";
import type { PagerMessage } from "@/pager/types";

export function useMessageHistory() {
  const { connection, revision, hasAccess } = useConnection();
  const [messages, setMessages] = useState<PagerMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const loadRef = useRef<(older?: boolean) => Promise<void>>(async () => {});
  const uid = connection?.uid;

  useEffect(() => {
    const saved = uid && hasAccess(uid) ? cachedMessages() : [];
    // Read the external SQLite cache when access changes.
    // oxlint-disable-next-line react/set-state-in-effect
    setMessages(saved);
    setNextCursor(saved.at(-1)?.id ?? null);
    setError(null);
    setLoading(false);
    if (!uid) return;
    let cancelled = false;
    let busy = false;
    let cursor: number | null = saved.at(-1)?.id ?? null;
    let initialized = saved.length > 0;
    let newestId = saved[0]?.id ?? 0;
    async function load(older = false) {
      if (busy || cancelled || !hasAccess(uid!) || (older && cursor === null))
        return;
      busy = true;
      setLoading(true);
      try {
        const page = await loadHistoryPage({
          newestId,
          before: older ? cursor! : undefined,
          getPage: getMessagePage,
          cancelled: () => cancelled || !hasAccess(uid!),
        });
        if (!page || cancelled || !hasAccess(uid!)) return;
        const received = page.messages;
        cacheMessages(received);
        setMessages((previous) => {
          if (!hasAccess(uid!)) return [];
          const combined = new Map(
            previous.map((message) => [message.id, message]),
          );
          for (const message of received) combined.set(message.id, message);
          return [...combined.values()].sort((a, b) => b.id - a.id);
        });
        if (older || !initialized) {
          cursor = page.nextCursor;
          setNextCursor(cursor);
        }
        initialized = true;
        newestId = Math.max(newestId, received[0]?.id ?? 0);
        setError(null);
      } catch (failure) {
        if (!cancelled && hasAccess(uid!))
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load messages.",
          );
      } finally {
        busy = false;
        if (!cancelled) setLoading(false);
      }
    }
    loadRef.current = load;
    void load();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      loadRef.current = async () => {};
    };
  }, [uid, hasAccess]);

  useEffect(() => {
    void loadRef.current();
  }, [revision]);
  return {
    messages,
    error,
    loading,
    nextCursor,
    refresh: () => {
      void loadRef.current();
    },
    loadMore: () => {
      void loadRef.current(true);
    },
  };
}
