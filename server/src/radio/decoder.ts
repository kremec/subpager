export type MessageType = "alpha" | "numeric" | "tone";

export interface Page {
  receivedAt: string;
  ric: number;
  function: number;
  type: MessageType;
  content: string;
}

export type Gain = number | "auto";

export interface RadioConfig {
  frequencyHz: number;
  device: string | number;
  gain: Gain;
  ppm: number;
  rtlFmPath: string;
  multimonPath: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRic(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2097151
  );
}

export function rtlFmArgs(config: RadioConfig): string[] {
  return [
    "-d",
    String(config.device),
    "-f",
    String(config.frequencyHz),
    "-M",
    "fm",
    "-s",
    "22050",
    "-E",
    "dc",
    "-p",
    String(config.ppm),
    ...(config.gain === "auto" ? [] : ["-g", String(config.gain)]),
    "-",
  ];
}

export function multimonArgs(): string[] {
  return [
    "-q",
    "-c",
    "-a",
    "POCSAG1200",
    "-t",
    "raw",
    "-f",
    "alpha",
    "-C",
    "SI",
    "--json",
    "-",
  ];
}

export function parseDecoderLine(
  line: string,
  receivedAt = new Date().toISOString(),
): Page | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { demod_name, address, function: fn, alpha, numeric } = value;
  if (
    demod_name !== "POCSAG1200" ||
    !isRic(address) ||
    typeof fn !== "number" ||
    !Number.isInteger(fn) ||
    fn < 0 ||
    fn > 3
  )
    return null;
  const type =
    typeof alpha === "string"
      ? "alpha"
      : typeof numeric === "string"
        ? "numeric"
        : "tone";
  const content =
    typeof alpha === "string"
      ? alpha
      : typeof numeric === "string"
        ? numeric
        : "";
  return {
    ric: address,
    function: fn,
    type,
    content,
    receivedAt,
  };
}
