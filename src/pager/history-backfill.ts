import type { MessagePage } from "@/pager/types";

interface HistoryBackfillOptions {
  newestId: number;
  before?: number;
  getPage: (before?: number) => Promise<MessagePage>;
  cancelled: () => boolean;
}

export async function loadHistoryPage(
  options: HistoryBackfillOptions,
): Promise<MessagePage | null> {
  const { newestId, before, getPage, cancelled } = options;
  const first = await getPage(before);
  if (cancelled()) return null;
  const messages = [...first.messages];
  let page = first;
  while (
    before === undefined &&
    newestId > 0 &&
    page.nextCursor !== null &&
    (page.messages.at(-1)?.id ?? 0) > newestId
  ) {
    page = await getPage(page.nextCursor);
    if (cancelled()) return null;
    messages.push(...page.messages);
  }
  return { messages, nextCursor: first.nextCursor };
}
