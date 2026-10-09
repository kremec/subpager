export interface Connection {
  uid: string;
}

export interface PagerMessage {
  id: string;
  receivedAt: string;
  ric: number;
  function: number;
  type: "alpha" | "numeric" | "tone";
  content: string;
  duplicateOf: string | null;
  location?: string | null;
}

export interface RicUnit {
  ric: number;
  unitName: string;
}

export interface SyncTimestamp {
  seconds: number;
  nanoseconds: number;
}

export interface MessageChanges {
  messages: PagerMessage[];
  removedIds: string[];
  cursor: SyncTimestamp;
  reset: boolean;
}

export interface CachedSync {
  initialized: boolean;
  cursor: SyncTimestamp;
  ricRevision: string | null;
}
