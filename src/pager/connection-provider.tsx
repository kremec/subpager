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
import {
  cacheApproval,
  cachedApproval,
  initializeDatabase,
} from "@/pager/database";
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
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isAuthenticated: backendAuthenticated } = useBackendAuth();
  const { signIn } = useAuthActions();
  const token = useAuthToken();
  const uid = authIdentity(token);
  const [access, setAccess] = useState<DeviceAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pushStatus, setPushStatus] = useState("Waiting for approval");
  const currentUid = useRef(uid);
  const accessUid = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentUid.current = uid;
    let allowed = false;
    try {
      initializeDatabase();
      allowed = !!uid && cachedApproval(uid);
    } catch {
      showErrorToast("Could not read saved device approval.");
    }
    accessUid.current = allowed ? uid : null;
    // Restore the external SQLite approval before painting the device's history.
    // oxlint-disable-next-line react/set-state-in-effect
    setAccess(uid ? { uid, approved: allowed } : null);
  }, [uid]);
  const signingIn = useRef(false);
  const hasAccess = useCallback(
    (value: string) =>
      currentUid.current === value && accessUid.current === value,
    [],
  );
  const approved = !!uid && access?.uid === uid && access.approved;
  const connectionError =
    error ??
    (!isLoading && isAuthenticated && !uid
      ? "This device identity is unavailable. Retry to reconnect."
      : null);
  const ready = !isLoading && (!!uid || !!connectionError);
  const connection = useMemo<Connection | null>(
    () => (approved && uid ? { uid } : null),
    [uid, approved],
  );
  const client = getConvex();

  useEffect(() => {
    if (isLoading || isAuthenticated || signingIn.current) return;
    signingIn.current = true;
    void signIn("anonymous")
      .catch((failure: Error) => {
        setError(failure.message);
      })
      .finally(() => {
        signingIn.current = false;
      });
  }, [isLoading, isAuthenticated, signIn, attempt]);

  useEffect(() => {
    if (!uid || !backendAuthenticated) return;
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
        try {
          cacheApproval(uid, allowed);
        } catch {
          showErrorToast("Could not save device approval.");
        }
        if (!allowed) {
          void Notifications.dismissAllNotificationsAsync().catch(() =>
            showErrorToast("Could not clear notifications."),
          );
          void Notifications.clearLastNotificationResponseAsync().catch(() =>
            showErrorToast("Could not clear notifications."),
          );
        }
        setError(null);
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
  }, [uid, backendAuthenticated, attempt, client]);

  useEffect(() => {
    if (connectionError) showErrorToast(connectionError);
  }, [connectionError]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (connectionError) retry();
    });
    return () => listener.remove();
  }, [connectionError, retry]);

  return (
    <ConnectionContext.Provider
      value={{
        connection,
        uid,
        approved,
        ready,
        error: connectionError,
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
