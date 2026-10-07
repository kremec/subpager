import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { request } from "@/pager/api";
import { useConnection } from "@/pager/connection-provider";
import { cachedMessages, cacheMessages } from "@/pager/database";
import type { MessagePage, PagerMessage, ReceiverStatus } from "@/pager/types";

export function useMessageHistory() {
  const { connection, revision } = useConnection();
  const [messages, setMessages] = useState<PagerMessage[]>([]);
  const [status, setStatus] = useState<ReceiverStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const loadRef = useRef<(older?: boolean) => Promise<void>>(async () => {});
  const cursor = useRef<number | null>(null);

  useEffect(() => {
    // Synchronize the visible history with the external SQLite cache when the connection changes.
    // oxlint-disable-next-line react/set-state-in-effect
    setMessages(connection ? cachedMessages() : []);
    setNextCursor(null);
    cursor.current = null;
    setStatus(null);
    setError(null);
    setLoading(false);
    if (!connection) return;
    const controller = new AbortController();
    let busy = false;
    let initialized = false;
    let newestId = 0;
    async function load(older = false) {
      if (
        !connection ||
        busy ||
        controller.signal.aborted ||
        (older && cursor.current === null)
      )
        return;
      busy = true;
      setLoading(true);
      try {
        const query = older ? `&before=${cursor.current}` : "";
        const timeout = controller.signal;
        const page = await request<MessagePage>(
          connection,
          `/v1/messages?limit=50&includeRepeats=true${query}`,
          { signal: timeout },
        );
        if (controller.signal.aborted) return;
        const received = [...page.messages];
        let catchupPage = page;
        // More than one page can arrive while the phone is offline. Fetch the gap
        // before merging the newest page into history that is already loaded.
        while (
          !older &&
          newestId > 0 &&
          catchupPage.nextCursor !== null &&
          (catchupPage.messages.at(-1)?.id ?? 0) > newestId
        ) {
          catchupPage = await request<MessagePage>(
            connection,
            `/v1/messages?limit=50&includeRepeats=true&before=${catchupPage.nextCursor}`,
            { signal: timeout },
          );
          if (controller.signal.aborted) return;
          received.push(...catchupPage.messages);
        }
        cacheMessages(received);
        const preserveLoaded = initialized;
        setMessages((previous) => {
          const combined = new Map(
            (preserveLoaded ? previous : []).map((message) => [
              message.id,
              message,
            ]),
          );
          for (const message of received) combined.set(message.id, message);
          return [...combined.values()].sort((a, b) => b.id - a.id);
        });
        if (older || !initialized) {
          cursor.current = page.nextCursor;
          setNextCursor(page.nextCursor);
        }
        initialized = true;
        newestId = Math.max(newestId, received[0]?.id ?? 0);
        setError(null);
        const receiver = await request<ReceiverStatus>(
          connection,
          "/v1/status",
          { signal: timeout },
        );
        if (!controller.signal.aborted) setStatus(receiver);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Could not load messages",
          );
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    loadRef.current = load;
    void load();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, 20_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      loadRef.current = async () => {};
    };
  }, [connection]);

  useEffect(() => {
    void loadRef.current();
  }, [revision]);
  return {
    messages,
    status,
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
