import { mkdir, writeFile } from "node:fs/promises";
import { isObject, type RadioConfig } from "./radio/decoder";
import type { ClipConfig } from "./radio";
import { dirname, resolve } from "node:path";

export interface Config {
  radio: RadioConfig & { device: string };
  clips: Required<ClipConfig>;
  outbox: string;
  firebase: { projectId: string; serviceAccountPath: string };
}

export const defaultConfig: Config = {
  radio: {
    frequencyHz: 173250000,
    device: "0",
    gain: "auto",
    ppm: 0,
    rtlFmPath: "rtl_fm",
    multimonPath: resolve(
      import.meta.dir,
      "../bin",
      process.platform === "win32"
        ? "multimon-ng-1.6.1.exe"
        : "multimon-ng-1.6.1",
    ),
  },
  clips: {
    enabled: false,
    directory: "./data/clips",
    preSeconds: 8,
    postSeconds: 4,
    maxFiles: 500,
    maxBytes: 256 * 1024 * 1024,
    continuous: false,
  },
  outbox: "./data/outbox",
  firebase: {
    projectId: "your-firebase-project",
    serviceAccountPath: "./receiver-service-account.json",
  },
};

function numberIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

export function validateConfig(value: unknown): asserts value is Config {
  if (
    !isObject(value) ||
    !isObject(value.radio) ||
    !isObject(value.clips) ||
    !isObject(value.firebase)
  ) {
    throw new Error(
      "Config requires radio, clips, outbox and firebase. Run bun run init for an example.",
    );
  }
  const { radio, clips, firebase } = value;
  if (
    value.convex !== undefined ||
    value.database !== undefined ||
    value.api !== undefined ||
    value.dedupeSeconds !== undefined ||
    value.pushMaxAgeSeconds !== undefined ||
    value.location !== undefined
  )
    throw new Error(
      "Remove legacy database, api and convex options; use the Firebase receiver configuration",
    );
  if (
    typeof firebase.projectId !== "string" ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebase.projectId) ||
    typeof firebase.serviceAccountPath !== "string" ||
    !firebase.serviceAccountPath
  )
    throw new Error("Firebase requires projectId and serviceAccountPath");
  if (
    !numberIn(radio.frequencyHz, 24000000, 1766000000) ||
    typeof radio.device !== "string" ||
    !radio.device ||
    !(radio.gain === "auto" || numberIn(radio.gain, 0, 50)) ||
    !numberIn(radio.ppm, -100, 100) ||
    typeof radio.rtlFmPath !== "string" ||
    !radio.rtlFmPath ||
    typeof radio.multimonPath !== "string" ||
    !radio.multimonPath ||
    typeof clips.enabled !== "boolean" ||
    typeof clips.continuous !== "boolean" ||
    typeof clips.directory !== "string" ||
    !clips.directory ||
    !numberIn(clips.preSeconds, 1, 120) ||
    !numberIn(clips.postSeconds, 1, 30) ||
    !numberIn(clips.maxFiles, 1, 10000) ||
    !Number.isInteger(clips.maxFiles) ||
    !numberIn(clips.maxBytes, 1048576, 10737418240) ||
    typeof value.outbox !== "string" ||
    !value.outbox
  ) {
    throw new Error(
      "Invalid config values. Compare with the generated example; gain must be auto or 0–50 dB.",
    );
  }
}

export async function loadConfig(
  path = process.env.SUBPAGER_CONFIG ?? "./config.json",
): Promise<Config> {
  const file = resolve(path);
  if (!(await Bun.file(file).exists()))
    throw new Error(`Config not found: ${file}. Run bun run init.`);
  const config: unknown = await Bun.file(file).json();
  validateConfig(config);
  config.outbox = resolve(dirname(file), config.outbox);
  config.clips.directory = resolve(dirname(file), config.clips.directory);
  config.firebase.serviceAccountPath = resolve(
    dirname(file),
    config.firebase.serviceAccountPath,
  );
  for (const key of ["rtlFmPath", "multimonPath"] as const) {
    if (config.radio[key].includes("/") || config.radio[key].includes("\\"))
      config.radio[key] = resolve(dirname(file), config.radio[key]);
  }
  return config;
}

export async function initConfig(
  path = process.env.SUBPAGER_CONFIG ?? "./config.json",
) {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(defaultConfig, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Refusing to overwrite ${file}`);
    throw error;
  }
  return file;
}
