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
import * as SecureStore from "expo-secure-store";

import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";

import { clearMessages, initializeDatabase } from "@/pager/database";
import { getFirebase, normalizeRics } from "@/pager/firebase";
import type { Connection } from "@/pager/types";

interface ConnectionContextValue {
  connection: Connection | null;
  uid: string | null;
  approved: boolean;
  approvalChecked: boolean;
  ready: boolean;
  error: string | null;
  revision: number;
  pushStatus: string;
  setPushStatus: (status: string) => void;
  refresh: () => void;
  retry: () => void;
  hasAccess: (uid: string) => boolean;
  saveRics: (rics: number[]) => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const STORAGE_KEY = "subpager.access";
interface SavedAccess {
  uid: string;
  approved: boolean;
  rics: number[];
}
interface ConnectionProviderProps {
  children: ReactNode;
}

export const ConnectionProvider: FC<ConnectionProviderProps> = (props) => {
  const [uid, setUid] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [approvalChecked, setApprovalChecked] = useState(false);
  const [rics, setRics] = useState<number[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [pushStatus, setPushStatus] = useState("Waiting for approval");
  const accessUid = useRef<string | null>(null);
  const hasAccess = useCallback(
    (value: string) => accessUid.current === value,
    [],
  );
  const connection = useMemo<Connection | null>(
    () => (approved && uid ? { uid, rics } : null),
    [uid, approved, rics],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribeMember = () => {};
    let unsubscribeAuth = () => {};
    let currentUid: string | null = null;
    async function initialize() {
      initializeDatabase();
      const { auth, database } = getFirebase();
      await auth.authStateReady();
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
      if (cancelled) return;
      currentUid = user.uid;
      const value = await SecureStore.getItemAsync(STORAGE_KEY);
      if (cancelled) return;
      const saved = value ? (JSON.parse(value) as SavedAccess) : null;
      accessUid.current =
        saved?.uid === user.uid && saved.approved ? user.uid : null;
      if (saved?.uid !== user.uid || !saved.approved) clearMessages();
      await SecureStore.deleteItemAsync("subpager.connection");
      if (cancelled) return;
      setUid(user.uid);
      setApproved(saved?.uid === user.uid && saved.approved);
      setRics(saved?.uid === user.uid ? normalizeRics(saved.rics) : []);
      setApprovalChecked(false);
      setError(null);
      unsubscribeMember = onSnapshot(
        doc(database, "members", user.uid),
        { includeMetadataChanges: true },
        (snapshot) => {
          // An empty SDK memory cache is not evidence of revoked access.
          if (cancelled || snapshot.metadata.fromCache) return;
          const allowed =
            snapshot.exists() && snapshot.data().approved === true;
          accessUid.current = allowed ? user.uid : null;
          if (!allowed) {
            clearMessages();
            void Notifications.dismissAllNotificationsAsync().catch(() => {});
            void Notifications.clearLastNotificationResponseAsync().catch(
              () => {},
            );
          }
          setApproved(allowed);
          setApprovalChecked(true);
          setError(null);
        },
        (failure) => {
          if (!cancelled) setError(failure.message);
        },
      );
      unsubscribeAuth = onAuthStateChanged(auth, (nextUser) => {
        if (cancelled || nextUser?.uid === currentUid) return;
        accessUid.current = null;
        unsubscribeMember();
        clearMessages();
        setApproved(false);
        setUid(null);
        setError(
          "This device identity is no longer available. Retry to request a new approval.",
        );
      });
    }
    void initialize()
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      accessUid.current = null;
      cancelled = true;
      unsubscribeMember();
      unsubscribeAuth();
    };
  }, [attempt]);

  useEffect(() => {
    if (!uid) return;
    void SecureStore.setItemAsync(
      STORAGE_KEY,
      JSON.stringify({ uid, approved, rics }),
    ).catch((failure: Error) => setError(failure.message));
  }, [uid, approved, rics]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const retry = useCallback(() => {
    setReady(false);
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      refresh();
      if (error) retry();
    });
    return () => listener.remove();
  }, [error, refresh, retry]);

  async function saveRics(value: number[]) {
    const next = normalizeRics(value);
    if (!uid || !hasAccess(uid))
      throw new Error("This device needs administrator approval first.");
    await SecureStore.setItemAsync(
      STORAGE_KEY,
      JSON.stringify({ uid, approved, rics: next }),
    );
    setRics(next);
  }

  return (
    <ConnectionContext.Provider
      value={{
        connection,
        uid,
        approved,
        approvalChecked,
        ready,
        error,
        revision,
        pushStatus,
        setPushStatus,
        refresh,
        retry,
        hasAccess,
        saveRics,
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
