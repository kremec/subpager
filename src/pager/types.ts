export interface Connection {
  baseUrl: string;
  apiKey: string;
  rics: number[];
}

export interface PagerMessage {
  id: number;
  receivedAt: string;
  ric: number;
  function: number;
  type: "alpha" | "numeric" | "tone";
  content: string;
  duplicateOf: number | null;
}

export interface MessagePage {
  messages: PagerMessage[];
  nextCursor: number | null;
}

export interface ReceiverStatus {
  receiver: {
    state: string;
    lastMessageAt: string | null;
    error: string | null;
  };
  pendingPushes: number;
  pushError?: string | null;
}
