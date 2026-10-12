import { formatMessageContent, formatRic } from "@/pager/format-message";
import type { PagerMessage, SpinEvent } from "@/pager/types";

const normalize = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

export function indexMessages(
  messages: PagerMessage[],
  unitNames?: ReadonlyMap<number, string>,
  spinEvents?: ReadonlyMap<string, SpinEvent>,
): Map<PagerMessage, string> {
  return new Map(
    messages.map((message) => {
      const event = message.spinEventId
        ? spinEvents?.get(message.spinEventId)
        : undefined;
      return [
        message,
        normalize(
          `${message.rics.map((ric) => `${formatRic(ric)} ${unitNames?.get(ric) ?? ""}`).join(" ")} ${formatMessageContent(message.content) || "Tone-only call"} ${event?.title ?? ""} ${event?.description ?? ""} ${event?.municipality ?? ""} ${event?.category ?? ""}`,
        ),
      ];
    }),
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
