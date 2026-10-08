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
