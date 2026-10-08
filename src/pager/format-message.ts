const receivedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "short",
  timeStyle: "short",
  hour12: false,
});

export function formatReceivedAt(receivedAt: string) {
  return receivedAtFormatter.format(new Date(receivedAt));
}

export function formatRic(ric: number) {
  return String(ric).padStart(7, "0");
}

export function formatRicUnit(ric: number, unitName?: string) {
  return unitName ? `${unitName} (${formatRic(ric)})` : formatRic(ric);
}

export function formatMessageContent(content: string) {
  return content.replace(/<CR><LF>|<(?:CR|LF)>|\r\n?/g, " ");
}
