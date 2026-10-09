import type { PagerMessage } from "@/pager/types";

export function messageLocation(message: PagerMessage) {
  const location = message.location;
  if (!location || !location.trim()) return null;
  const start = message.content.indexOf(location);
  if (start < 0) return null;
  return {
    before: message.content.slice(0, start),
    location,
    after: message.content.slice(start + location.length),
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location}, Slovenija`)}`,
  };
}
