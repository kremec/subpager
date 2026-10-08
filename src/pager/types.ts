export interface Connection {
  uid: string;
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

export interface RicUnit {
  ric: number;
  unitName: string;
}
