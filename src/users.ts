import type {
  Firestore,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import type { PushRecipient } from "./delivery";

// Share one user subscription between ingestion and push authorization.
export class FirestoreUsers {
  private documents = new Map<string, QueryDocumentSnapshot>();
  private connected = false;
  private stopped = false;
  private unsubscribe?: () => void;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private waiting?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };

  constructor(private db: Firestore) {}

  ready(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("User registry stopped"));
    if (this.connected) return Promise.resolve();
    if (this.reconnectTimer)
      return Promise.reject(new Error("User listener disconnected"));
    if (!this.waiting) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      this.waiting = { promise, resolve, reject };
    }
    const promise = this.waiting.promise;
    if (!this.unsubscribe && !this.reconnectTimer) this.listen();
    return promise;
  }

  private listen() {
    this.unsubscribe = this.db.collection("users").onSnapshot(
      (snapshot) => {
        if (this.stopped) return;
        this.documents = new Map(snapshot.docs.map((doc) => [doc.id, doc]));
        this.connected = true;
        this.waiting?.resolve();
        this.waiting = undefined;
      },
      () => {
        if (this.stopped) return;
        this.connected = false;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.waiting?.reject(new Error("User listener disconnected"));
        this.waiting = undefined;
        if (!this.stopped)
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.listen();
          }, 30_000);
      },
    );
  }

  private requireConnected() {
    if (this.stopped || !this.connected)
      throw new Error("User listener disconnected");
  }

  recipients(): PushRecipient[] {
    this.requireConnected();
    const now = Date.now();
    return [...this.documents.values()].flatMap((doc) => {
      const token: unknown = doc.get("expoPushToken");
      return doc.get("approved") === true && typeof token === "string" && token
        ? [
            {
              deviceId: doc.id,
              expoPushToken: token,
              tokenUpdatedAt: doc.updateTime,
              state: "pending" as const,
              nextAttempt: now,
              attempts: 0,
            },
          ]
        : [];
    });
  }

  authorized(recipient: PushRecipient): boolean {
    this.requireConnected();
    const device = this.documents.get(recipient.deviceId);
    return (
      device?.get("approved") === true &&
      device.get("expoPushToken") === recipient.expoPushToken
    );
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.unsubscribe?.();
    this.waiting?.reject(new Error("User registry stopped"));
    this.waiting = undefined;
  }
}
