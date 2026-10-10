import { createContext, useContext } from "react";

import type { PagerMessage, SpinEvent } from "@/pager/types";

interface HistoryContextValue {
  messages: PagerMessage[];
  unitNames: ReadonlyMap<number, string>;
  spinEvents: ReadonlyMap<string, SpinEvent>;
  loading: boolean;
  syncVersion: number;
}

export const HistoryContext = createContext<HistoryContextValue | null>(null);

export function useMessageHistory() {
  const value = useContext(HistoryContext);
  if (!value) throw new Error("HistoryProvider is missing.");
  return value;
}
