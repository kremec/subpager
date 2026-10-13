import type { Page } from "./radio/decoder";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Ljubljana",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function pagerDay(time: string) {
  return dayFormatter.format(new Date(time));
}

// Receptions have already been restricted to one daily event.
export function isEcho(
  receptions: { ric: number; time: string }[],
  reception: { ric: number; time: string },
) {
  const time = Date.parse(reception.time);
  return receptions.some(
    (item) =>
      item.ric === reception.ric &&
      Math.abs(Date.parse(item.time) - time) <= 30_000,
  );
}

export function normalizeContent(content: string) {
  return (
    content
      .replace(/<CR><LF>|<(?:CR|LF)>|\r\n?|\n/g, " ")
      // oxlint-disable-next-line no-control-regex
      .replace(/(?:<(?:EOT|NUL)>|[\x00\x04])+$/, "")
  );
}

function comparisonText(content: string) {
  return normalizeContent(content)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function canGroupPages(
  anchor: Pick<Page, "type" | "function" | "content">,
  page: Pick<Page, "type" | "function" | "content">,
) {
  if (anchor.type !== page.type || anchor.function !== page.function)
    return false;
  const a = comparisonText(anchor.content);
  const b = comparisonText(page.content);
  if (a === b) return true;
  // Changed numbers and short instructions are unsafe to match approximately.
  const budget = Math.min(3, Math.floor(Math.min(a.length, b.length) * 0.02));
  if (
    anchor.type !== "alpha" ||
    budget === 0 ||
    Math.abs(a.length - b.length) > budget ||
    (a.match(/\d+/g) ?? []).join(" ") !== (b.match(/\d+/g) ?? []).join(" ")
  )
    return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = Array<number>(b.length + 1).fill(Infinity);
    current[0] = i;
    for (
      let j = Math.max(1, i - budget);
      j <= Math.min(b.length, i + budget);
      j++
    ) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]! <= budget;
}
