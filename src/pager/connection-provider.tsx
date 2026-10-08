import {
  createContext,
  useCallback,
  type FC,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import {
  useAuthActions,
  useAuthToken,
  useConvexAuth,
} from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { useConvexAuth as useBackendAuth } from "convex/react";

import { showErrorToast } from "@/components/ui/toast";
import { authIdentity } from "@/pager/auth-identity";
import { getConvex } from "@/pager/convex";
import { clearMessages, initializeDatabase } from "@/pager/database";
import type { Connection } from "@/pager/types";

interface ConnectionContextValue {
  connection: Connection | null;
  uid: string | null;
  approved: boolean;
  ready: boolean;
  error: string | null;
  revision: number;
  pushStatus: string;
  setPushStatus: (status: string) => void;
  refresh: () => void;
  retry: () => void;
  hasAccess: (uid: string) => boolean;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
interface SavedAccess {
  uid: string;
  approved: boolean;
}
interface ConnectionProviderProps {
  children: ReactNode;
}

export const ConnectionProvider: FC<ConnectionProviderProps> = (props) => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isAuthenticated: backendAuthenticated } = useBackendAuth();
  const { signIn } = useAuthActions();
  const token = useAuthToken();
  const uid = authIdentity(token);
  const [access, setAccess] = useState<SavedAccess | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [pushStatus, setPushStatus] = useState("Waiting for approval");
  const currentUid = useRef(uid);
  useLayoutEffect(() => {
    currentUid.current = uid;
  }, [uid]);
  const accessUid = useRef<string | null>(null);
  const signingIn = useRef(false);
  const accessWrite = useRef(Promise.resolve());
  const hasAccess = useCallback(
    (value: string) =>
      currentUid.current === value && accessUid.current === value,
    [],
  );
  const approved = !!uid && access?.uid === uid && access.approved;
  const connection = useMemo<Connection | null>(
    () => (approved && uid ? { uid } : null),
    [uid, approved],
  );
  const client = getConvex();
  const storageKey = `subpager.convex-access.${new URL(client.url).hostname}`;

  useEffect(() => {
    if (isLoading || isAuthenticated || signingIn.current) return;
    signingIn.current = true;
    void signIn("anonymous")
      .catch((failure: Error) => {
        setError(failure.message);
        setReady(true);
      })
      .finally(() => {
        signingIn.current = false;
      });
  }, [isLoading, isAuthenticated, signIn, attempt]);

  useEffect(() => {
    if (isLoading) return;
    let cancelled = false;
    accessUid.current = null;
    const allowedIdentity = () => !cancelled && currentUid.current === uid;
    async function initialize() {
      initializeDatabase();
      if (!uid) {
        clearMessages();
        setAccess(null);
        if (isAuthenticated)
          throw new Error(
            "This device identity is unavailable. Retry to reconnect.",
          );
        return;
      }
      await accessWrite.current;
      const value = await SecureStore.getItemAsync(storageKey);
      if (!allowedIdentity()) return;
      const saved = value ? (JSON.parse(value) as SavedAccess) : null;
      const savedApproved = saved?.uid === uid && saved.approved === true;
      accessUid.current = savedApproved ? uid : null;
      if (!savedApproved) clearMessages();
      setAccess({ uid, approved: savedApproved });
      setError(null);
      setReady(true);
    }
    void initialize().catch((failure: Error) => {
      if (!allowedIdentity()) return;
      setError(failure.message);
      setReady(true);
    });
    return () => {
      accessUid.current = null;
      cancelled = true;
    };
  }, [uid, isLoading, isAuthenticated, attempt, storageKey]);

  useEffect(() => {
    if (!uid || !ready || !backendAuthenticated) return;
    let cancelled = false;
    const allowedIdentity = () => !cancelled && currentUid.current === uid;
    const watch = client.watchQuery(api.devices.current, {});
    const update = () => {
      if (!allowedIdentity()) return;
      try {
        const device = watch.localQueryResult();
        if (!device || device.uid !== uid) return;
        const allowed = device.approved;
        accessUid.current = allowed ? uid : null;
        setAccess({ uid, approved: allowed });
        if (!allowed) {
          try {
            clearMessages();
          } catch {
            showErrorToast("Could not clear saved history.");
          }
          void Notifications.dismissAllNotificationsAsync().catch(() =>
            showErrorToast("Could not clear notifications."),
          );
          void Notifications.clearLastNotificationResponseAsync().catch(() =>
            showErrorToast("Could not clear notifications."),
          );
        }
        setError(null);
        accessWrite.current = accessWrite.current
          .then(() =>
            SecureStore.setItemAsync(
              storageKey,
              JSON.stringify({ uid, approved: allowed }),
            ),
          )
          .catch((failure: Error) => {
            if (allowedIdentity()) setError(failure.message);
          });
      } catch (failure) {
        if (allowedIdentity())
          setError(
            failure instanceof Error ? failure.message : "Connection failed.",
          );
      }
    };
    const unsubscribe = watch.onUpdate(update);
    update();
    void client.mutation(api.devices.register, {}).catch((failure: Error) => {
      if (allowedIdentity()) setError(failure.message);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [uid, ready, backendAuthenticated, attempt, client, storageKey]);

  useEffect(() => {
    if (error) showErrorToast(error);
  }, [error]);

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

  return (
    <ConnectionContext.Provider
      value={{
        connection,
        uid,
        approved,
        ready,
        error,
        revision,
        pushStatus,
        setPushStatus,
        refresh,
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
