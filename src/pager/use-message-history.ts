import { createContext, useContext } from "react";

import type { PagerMessage } from "@/pager/types";

interface HistoryContextValue {
  messages: PagerMessage[];
  unitNames: ReadonlyMap<number, string>;
  loading: boolean;
  refresh: () => void;
}

export const HistoryContext = createContext<HistoryContextValue | null>(null);

export function useMessageHistory() {
  const value = useContext(HistoryContext);
  if (!value) throw new Error("HistoryProvider is missing.");
  return value;
}
