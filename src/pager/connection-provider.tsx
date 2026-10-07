import {
  createContext,
  useCallback,
  type FC,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import { disconnectDevice, normalizeConnection, request } from "@/pager/api";
import { clearMessages, initializeDatabase } from "@/pager/database";
import type { Connection, ReceiverStatus } from "@/pager/types";

interface ConnectionContextValue {
  connection: Connection | null;
  ready: boolean;
  error: string | null;
  revision: number;
  pushStatus: string;
  setPushStatus: (status: string) => void;
  refresh: () => void;
  save: (connection: Connection) => Promise<void>;
  disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const STORAGE_KEY = "subpager.connection";
interface ConnectionProviderProps {
  children: ReactNode;
}

export const ConnectionProvider: FC<ConnectionProviderProps> = (props) => {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pushStatus, setPushStatus] = useState("Not connected");
  const current = useRef<Connection | null>(null);

  useEffect(() => {
    void (async () => {
      initializeDatabase();
      const value = await SecureStore.getItemAsync(STORAGE_KEY);
      const restored = value
        ? normalizeConnection(JSON.parse(value) as Connection)
        : null;
      current.current = restored;
      setConnection(restored);
    })()
      .catch((error: Error) => setError(error.message))
      .finally(() => setReady(true));
  }, []);

  async function save(value: Connection) {
    const next = normalizeConnection(value);
    await request<ReceiverStatus>(next, "/v1/status");
    const previous = current.current;
    const changed =
      previous &&
      (previous.baseUrl !== next.baseUrl || previous.apiKey !== next.apiKey);
    if (changed) await disconnectDevice(previous);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      // A failed local write keeps the old credentials and starts a new push
      // registration session because the preceding DELETE retired the old one.
      if (changed) {
        const restored = { ...previous };
        current.current = restored;
        setConnection(restored);
      }
      throw error;
    }
    if (changed || !previous) {
      clearMessages();
      await Notifications.dismissAllNotificationsAsync();
      await Notifications.clearLastNotificationResponseAsync();
    }
    current.current = next;
    setConnection(next);
  }

  async function disconnect() {
    const previous = current.current;
    if (previous) await disconnectDevice(previous);
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    } catch (error) {
      if (previous) {
        const restored = { ...previous };
        current.current = restored;
        setConnection(restored);
      }
      throw error;
    }
    clearMessages();
    await Notifications.dismissAllNotificationsAsync();
    await Notifications.clearLastNotificationResponseAsync();
    current.current = null;
    setConnection(null);
  }

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  return (
    <ConnectionContext.Provider
      value={{
        connection,
        ready,
        error,
        revision,
        pushStatus,
        setPushStatus,
        refresh,
        save,
        disconnect,
      }}
    >
      {props.children}
    </ConnectionContext.Provider>
  );
};

export function useConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("ConnectionProvider is missing.");
  return value;
}
