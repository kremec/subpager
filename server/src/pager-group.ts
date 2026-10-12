import type { Page } from "./radio/decoder";

export const GROUPING_WINDOW_MS = 3 * 60_000;

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

export function canGroupPages(anchor: Page, page: Page) {
  const elapsed = Math.abs(
    Date.parse(anchor.receivedAt) - Date.parse(page.receivedAt),
  );
  if (
    elapsed > GROUPING_WINDOW_MS ||
    anchor.type !== page.type ||
    anchor.function !== page.function
  )
    return false;
  const a = comparisonText(anchor.content);
  const b = comparisonText(page.content);
  if (anchor.type === "tone" || !a || !b)
    return elapsed <= 30_000 && anchor.ric === page.ric && a === b;
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
