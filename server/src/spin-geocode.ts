import { isObject } from "./radio/decoder";

export interface SpinAddress {
  address: string;
  latitude: number;
  longitude: number;
}

const locator =
  "https://geohub.gov.si/ags/rest/services/GeoLokatorji/GH_ISKALNIK_NASLOVI_JEP/GeocodeServer";

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export async function geocodeSpinAddress(
  location: string,
  request: typeof fetch = fetch,
): Promise<SpinAddress[]> {
  const components = location.split(",").flatMap((component) => {
    const match = /^(.+?)\s+(\d+\s*[a-z]?)$/i.exec(component.trim());
    return match
      ? [
          {
            text: component.trim(),
            name: normalized(match[1]!),
            number: normalized(match[2]!).replace(/\s/g, ""),
          },
        ]
      : [];
  });
  if (!components.length) return [];

  async function read(path: string, params: Record<string, string>) {
    const url = new URL(`${locator}/${path}`);
    url.search = new URLSearchParams({ f: "json", ...params }).toString();
    const response = await request(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`SPIN address geocoder HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isObject(payload) || payload.error)
      throw new Error("Invalid SPIN address geocoder response");
    return payload;
  }

  const addresses = new Map<string, SpinAddress>();
  const suggestions = new Map<string, Record<string, unknown>[]>();
  const resolved = new Map<string, Record<string, unknown>[]>();
  for (const component of components) {
    for (const query of new Set([location.trim(), component.text])) {
      if (!suggestions.has(query)) {
        const payload = await read("suggest", {
          text: query,
          maxSuggestions: "20",
        });
        if (!Array.isArray(payload.suggestions))
          throw new Error("Invalid SPIN address suggestions");
        suggestions.set(query, payload.suggestions.filter(isObject));
      }
      for (const suggestion of suggestions.get(query)!) {
        if (
          typeof suggestion.text !== "string" ||
          typeof suggestion.magicKey !== "string"
        )
          continue;
        const [name, number, town] = suggestion.text.split(",");
        const matchesTownPrefix =
          !!name &&
          !!town &&
          component.name === `${normalized(town)} ${normalized(name)}`;
        if (
          !name ||
          !number ||
          (normalized(name) !== component.name && !matchesTownPrefix) ||
          normalized(number).replace(/\s/g, "") !== component.number
        )
          continue;
        if (!resolved.has(suggestion.magicKey)) {
          const payload = await read("findAddressCandidates", {
            SingleLine: suggestion.text,
            magicKey: suggestion.magicKey,
            outSR: "4326",
            outFields: "*",
            maxLocations: "10",
          });
          if (!Array.isArray(payload.candidates))
            throw new Error("Invalid SPIN address candidates");
          resolved.set(
            suggestion.magicKey,
            payload.candidates.filter(isObject),
          );
        }
        for (const candidate of resolved.get(suggestion.magicKey)!) {
          const attributes = candidate.attributes;
          const point = candidate.location;
          // This locator uses Nbrhd for the address name and City for its house number.
          if (
            !isObject(attributes) ||
            !isObject(point) ||
            typeof attributes.Nbrhd !== "string" ||
            typeof attributes.City !== "string" ||
            normalized(attributes.Nbrhd) !== normalized(name) ||
            normalized(attributes.City).replace(/\s/g, "") !==
              component.number ||
            (matchesTownPrefix &&
              (typeof attributes.Subregion !== "string" ||
                normalized(attributes.Subregion) !== normalized(town!))) ||
            attributes.Status !== "M" ||
            candidate.score !== 100 ||
            typeof candidate.address !== "string" ||
            typeof point.y !== "number" ||
            typeof point.x !== "number" ||
            !Number.isFinite(point.y) ||
            !Number.isFinite(point.x) ||
            Math.abs(point.y) > 90 ||
            Math.abs(point.x) > 180
          )
            continue;
          addresses.set(candidate.address, {
            address: candidate.address,
            latitude: point.y,
            longitude: point.x,
          });
        }
      }
    }
  }
  return [...addresses.values()];
}

export function spinDistanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = Math.PI / 180;
  const latitude = (b.latitude - a.latitude) * radians;
  const longitude = (b.longitude - a.longitude) * radians;
  const h =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(a.latitude * radians) *
      Math.cos(b.latitude * radians) *
      Math.sin(longitude / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
