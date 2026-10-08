export interface Connection {
  uid: string;
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
