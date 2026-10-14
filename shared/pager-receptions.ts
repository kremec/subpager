interface PagerReception {
  ric: number;
  time: string;
}

// Callers restrict receptions to one matching daily event.
export function isEcho(receptions: PagerReception[], reception: PagerReception) {
  const time = Date.parse(reception.time);
  return receptions.some(
    (item) => item.ric === reception.ric && Math.abs(Date.parse(item.time) - time) <= 60_000,
  );
}

export function withoutEchoes(receptions: PagerReception[]) {
  const retained: PagerReception[] = [];
  for (const reception of [...receptions].sort((a, b) => a.time.localeCompare(b.time))) {
    if (!isEcho(retained, reception)) retained.push(reception);
  }
  return retained;
}
