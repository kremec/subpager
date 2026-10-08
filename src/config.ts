import { mkdir, writeFile } from "node:fs/promises";
import { isObject, type RadioConfig } from "./radio/decoder";
import type { ClipConfig } from "./radio";
import { dirname, resolve } from "node:path";

export interface Config {
  radio: RadioConfig & { device: string };
  clips: Required<ClipConfig>;
  database: string;
  api: { host: string; port: number };
  dedupeSeconds: number;
  pushMaxAgeSeconds: number;
  firebase?: { projectId: string; serviceAccountPath: string };
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
    enabled: true,
    directory: "./data/clips",
    preSeconds: 8,
    postSeconds: 4,
    maxFiles: 500,
    maxBytes: 256 * 1024 * 1024,
    continuous: false,
  },
  database: "./data/subpager.sqlite",
  api: { host: "127.0.0.1", port: 8787 },
  dedupeSeconds: 30,
  pushMaxAgeSeconds: 300,
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
    !isObject(value.api)
  ) {
    throw new Error(
      "Config requires radio, clips and api objects. Run bun run init for an example.",
    );
  }
  const { radio, clips, api } = value;
  if (
    value.firebase !== undefined &&
    (!isObject(value.firebase) ||
      typeof value.firebase.projectId !== "string" ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.firebase.projectId) ||
      typeof value.firebase.serviceAccountPath !== "string" ||
      !value.firebase.serviceAccountPath)
  ) {
    throw new Error("Firebase requires projectId and serviceAccountPath");
  }
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
    typeof value.database !== "string" ||
    !value.database ||
    typeof api.host !== "string" ||
    !api.host ||
    !numberIn(api.port, 1, 65535) ||
    !Number.isInteger(api.port) ||
    !numberIn(value.dedupeSeconds, 0, 300) ||
    !numberIn(value.pushMaxAgeSeconds, 1, 86400)
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
  config.database = resolve(dirname(file), config.database);
  config.clips.directory = resolve(dirname(file), config.clips.directory);
  if (config.firebase)
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
