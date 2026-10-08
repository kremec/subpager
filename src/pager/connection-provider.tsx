import {
  createContext,
  useCallback,
  type FC,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import * as Notifications from "expo-notifications";

import {
  type Auth,
  onAuthStateChanged,
  signInAnonymously,
} from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";

import { showErrorToast } from "@/components/ui/toast";
import {
  cacheApproval,
  cachedApproval,
  initializeDatabase,
} from "@/pager/database";
import { getFirebase } from "@/pager/firebase";
import type { Connection } from "@/pager/types";

interface ConnectionContextValue {
  connection: Connection | null;
  uid: string | null;
  approved: boolean;
  ready: boolean;
  error: string | null;
  pushStatus: string;
  setPushStatus: (status: string) => void;
  retry: () => void;
  hasAccess: (uid: string) => boolean;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
interface DeviceAccess {
  uid: string;
  approved: boolean;
}
interface ConnectionProviderProps {
  children: ReactNode;
}

export const ConnectionProvider: FC<ConnectionProviderProps> = (props) => {
  const [uid, setUid] = useState<string | null>(null);
  const [access, setAccess] = useState<DeviceAccess | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pushStatus, setPushStatus] = useState("Waiting for approval");
  const authRef = useRef<Auth | null>(null);
  const currentUid = useRef<string | null>(null);
  const accessUid = useRef<string | null>(null);
  const hasAccess = useCallback(
    (value: string) =>
      authRef.current?.currentUser?.uid === value &&
      currentUid.current === value &&
      accessUid.current === value,
    [],
  );
  const approved = !!uid && access?.uid === uid && access.approved;
  const connection = useMemo<Connection | null>(
    () => (approved && uid ? { uid } : null),
    [uid, approved],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribeAuth = () => {};
    let unsubscribeMember = () => {};
    async function connect() {
      try {
        const { auth, database } = getFirebase();
        authRef.current = auth;
        await auth.authStateReady();
        if (cancelled) return;
        if (!auth.currentUser) await signInAnonymously(auth);
        if (cancelled) return;
        unsubscribeAuth = onAuthStateChanged(auth, (user) => {
          if (cancelled) return;
          unsubscribeMember();
          const nextUid = user?.uid ?? null;
          currentUid.current = nextUid;
          let allowed = false;
          try {
            initializeDatabase();
            allowed = !!nextUid && cachedApproval(nextUid);
          } catch {
            showErrorToast("Could not read saved device approval.");
          }
          accessUid.current = allowed ? nextUid : null;
          setUid(nextUid);
          setAccess(nextUid ? { uid: nextUid, approved: allowed } : null);
          setReady(true);
          if (!nextUid) {
            setError(
              "This device identity is unavailable. Retry to reconnect.",
            );
            return;
          }
          setError(null);
          const matchingIdentity = () =>
            !cancelled &&
            currentUid.current === nextUid &&
            auth.currentUser?.uid === nextUid;
          unsubscribeMember = onSnapshot(
            doc(database, "members", nextUid),
            { includeMetadataChanges: true },
            (snapshot) => {
              if (!matchingIdentity() || snapshot.metadata.fromCache) return;
              const approvedByServer = snapshot.data()?.approved === true;
              accessUid.current = approvedByServer ? nextUid : null;
              setAccess({ uid: nextUid, approved: approvedByServer });
              try {
                cacheApproval(nextUid, approvedByServer);
              } catch {
                showErrorToast(
                  approvedByServer
                    ? "Could not save device approval."
                    : "Could not clear saved history. Offline history may remain on this device.",
                );
              }
              if (!approvedByServer) {
                void Notifications.dismissAllNotificationsAsync().catch(() =>
                  showErrorToast("Could not clear notifications."),
                );
                void Notifications.clearLastNotificationResponseAsync().catch(
                  () => showErrorToast("Could not clear notifications."),
                );
              }
              setError(null);
            },
            (failure) => {
              if (matchingIdentity()) setError(failure.message);
            },
          );
        });
      } catch (failure) {
        if (cancelled) return;
        setError(
          failure instanceof Error ? failure.message : "Connection failed.",
        );
        setReady(true);
      }
    }
    void connect();
    return () => {
      cancelled = true;
      unsubscribeAuth();
      unsubscribeMember();
    };
  }, [attempt]);

  useEffect(() => {
    if (error) showErrorToast(error);
  }, [error]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active" && error) retry();
    });
    return () => listener.remove();
  }, [error, retry]);

  return (
    <ConnectionContext.Provider
      value={{
        connection,
        uid,
        approved,
        ready,
        error,
        pushStatus,
        setPushStatus,
        retry,
        hasAccess,
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
