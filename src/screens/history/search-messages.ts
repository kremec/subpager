import { formatMessageContent, formatRic } from "@/pager/format-message";
import type { PagerMessage } from "@/pager/types";

const normalize = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

export function indexMessages(
  messages: PagerMessage[],
  unitNames?: ReadonlyMap<number, string>,
): Map<PagerMessage, string> {
  return new Map(
    messages.map((message) => [
      message,
      normalize(
        `${formatRic(message.ric)} ${unitNames?.get(message.ric) ?? ""} ${formatMessageContent(message.content) || "Tone-only call"}`,
      ),
    ]),
  );
}

export function searchMessages(
  index: ReadonlyMap<PagerMessage, string>,
  query: string,
): PagerMessage[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches: PagerMessage[] = [];
  for (const [message, text] of index)
    if (terms.every((term) => text.includes(term))) matches.push(message);
  return matches;
}
