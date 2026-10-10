import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface SpinEvent {
  id: string;
  title: string;
  description: string;
  eventAt: string;
  municipality?: string;
  category?: string;
  reportedAtLocal?: string;
  latitude?: number;
  longitude?: number;
}

export function publicSpinEvent(event: SpinEvent): SpinEvent {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    eventAt: event.eventAt,
    ...(event.municipality !== undefined
      ? { municipality: event.municipality }
      : {}),
    ...(event.category !== undefined ? { category: event.category } : {}),
    ...(event.reportedAtLocal !== undefined
      ? { reportedAtLocal: event.reportedAtLocal }
      : {}),
    ...(event.latitude !== undefined ? { latitude: event.latitude } : {}),
    ...(event.longitude !== undefined ? { longitude: event.longitude } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid SPIN data");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid SPIN text");
  return value.trim();
}

function incidentId(value: unknown): string {
  const url = new URL(text(value));
  const id = /^\/javno\/zemljevid\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  if (
    url.origin !== "https://spin3.sos112.si" ||
    !id ||
    url.search ||
    url.hash ||
    !Number.isSafeInteger(Number(id))
  ) {
    throw new Error("Invalid SPIN incident ID");
  }
  return id;
}

export function parseSpinFeed(xml: string): SpinEvent[] {
  if (XMLValidator.validate(xml) !== true)
    throw new Error("Invalid SPIN RSS XML");
  const parsed: unknown = new XMLParser({
    parseTagValue: false,
    trimValues: false,
    htmlEntities: true,
  }).parse(xml);
  const rawChannel = record(record(parsed).rss).channel;
  if (typeof rawChannel === "string" && rawChannel.trim() === "") return [];
  const channel = record(rawChannel);
  if (channel.item === undefined) return [];
  const items = Array.isArray(channel.item) ? channel.item : [channel.item];
  const ids = new Set<string>();
  return items.map((value): SpinEvent => {
    const item = record(value);
    const id = incidentId(item.guid ?? item.link);
    if (item.link !== undefined && incidentId(item.link) !== id) {
      throw new Error("Conflicting SPIN incident IDs");
    }
    if (ids.has(id)) throw new Error("Duplicate SPIN incident ID");
    ids.add(id);
    const title = text(item.title);
    const timestamp = Date.parse(text(item.pubDate));
    if (!title || !Number.isFinite(timestamp))
      throw new Error("Invalid SPIN RSS item");
    return {
      id,
      title,
      description: text(item.description),
      eventAt: new Date(timestamp).toISOString(),
    };
  });
}

export function parseSpinDetail(payload: unknown): Partial<SpinEvent> {
  const wrapper = record(payload);
  if (wrapper.statusCode !== undefined && wrapper.statusCode !== 200) {
    throw new Error("SPIN detail request failed");
  }
  if (wrapper.value === undefined) return {};
  const value = record(wrapper.value);
  const event: Partial<SpinEvent> = {};
  const fields = {
    besedilo: "description",
    obcinaNaziv: "municipality",
    dogodekNaziv: "category",
  } as const;
  for (const [source, target] of Object.entries(fields)) {
    if (value[source] === undefined || value[source] === null) continue;
    const content = text(value[source]);
    if (content) event[target] = content;
  }
  if (event.description === event.municipality) delete event.description;
  if (value.prijavaCas !== undefined && value.prijavaCas !== null) {
    const local = text(value.prijavaCas);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(local) ||
      !Number.isFinite(Date.parse(`${local}Z`)) ||
      new Date(`${local}Z`).toISOString().slice(0, 19) !== local.slice(0, 19)
    ) {
      throw new Error("Invalid SPIN local report time");
    }
    event.reportedAtLocal = local;
  }
  for (const [source, target, maximum] of [
    ["wgsLatApprox", "latitude", 90],
    ["wgsLonApprox", "longitude", 180],
  ] as const) {
    const coordinate = value[source];
    if (coordinate === undefined || coordinate === null) continue;
    if (
      typeof coordinate !== "number" ||
      !Number.isFinite(coordinate) ||
      Math.abs(coordinate) > maximum
    ) {
      throw new Error("Invalid SPIN approximate coordinate");
    }
    event[target] = coordinate;
  }
  return event;
}

export function hasSpinReport(
  event: SpinEvent,
  municipalities?: ReadonlySet<string>,
): boolean {
  const description = event.description.trim();
  return (
    description !== "" &&
    description !== event.municipality?.trim() &&
    !municipalities?.has(description)
  );
}
