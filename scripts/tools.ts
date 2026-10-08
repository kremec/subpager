import { dirname, join, resolve } from "node:path";
import { loadConfig, initConfig } from "../src/config";
import { RadioReceiver, replayWav, surveyGains } from "../src/radio";
import { parseDecoderLine, type Page } from "../src/radio/decoder";
import { Store } from "../src/store";
import { ConvexClient, ConvexWorker } from "../src/convex";

export async function setup(configureUsb = false) {
  const install =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(import.meta.dir, "setup.ps1"),
        ]
      : [
          "bash",
          resolve(import.meta.dir, "setup.sh"),
          ...(configureUsb ? ["--configure-usb"] : []),
        ];
  const child = Bun.spawn(install, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Radio installation failed (${code})`);
  if (
    !(await Bun.file(process.env.SUBPAGER_CONFIG ?? "./config.json").exists())
  )
    console.log(`Created ${await initConfig()}`);
  console.log(
    "Run bun run doctor after connecting the receiver. See README.md for driver-specific steps.",
  );
}

export async function doctor() {
  const config = await loadConfig();
  let active: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    active?.kill("SIGKILL");
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let failed = false;
    for (const [name, path] of [
      ["rtl_fm", config.radio.rtlFmPath],
      ["multimon-ng", config.radio.multimonPath],
    ] as const) {
      const found =
        path.includes("/") || path.includes("\\")
          ? await Bun.file(path).exists()
          : !!Bun.which(path);
      console.log(`${name}: ${found ? path : "NOT INSTALLED"}`);
      failed ||= !found;
    }
    console.log(
      `Frequency: ${config.radio.frequencyHz} Hz, gain: ${config.radio.gain}, PPM: ${config.radio.ppm}`,
    );
    console.log(
      `Database: ${config.database}; clips: ${config.clips.directory}`,
    );
    if (!failed && !cancelled) {
      const decoder = (active = Bun.spawn(
        [config.radio.multimonPath, "--help"],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
          killSignal: "SIGKILL",
        },
      ));
      const [stdout, stderr] = await Promise.all([
        new Response(decoder.stdout).text(),
        new Response(decoder.stderr).text(),
        decoder.exited,
      ]);
      const help = stdout + stderr;
      if (cancelled) return;
      if (!help.includes("--json")) {
        console.error(
          "Decoder does not advertise --json; install multimon-ng 1.6.1.",
        );
        failed = true;
      }
    }
    if (cancelled) return;
    const rtlFm = Bun.which(config.radio.rtlFmPath) ?? config.radio.rtlFmPath;
    const rtlSdr = join(
      dirname(rtlFm),
      process.platform === "win32" ? "rtl_sdr.exe" : "rtl_sdr",
    );
    if (await Bun.file(rtlSdr).exists()) {
      if (cancelled) return;
      console.log(
        "Checking USB/tuning with a finite 4096-sample I/Q capture. Stop the server first so it releases the dongle.",
      );
      const result = (active = Bun.spawn(
        [
          rtlSdr,
          "-d",
          config.radio.device,
          "-f",
          String(config.radio.frequencyHz),
          "-s",
          "1024000",
          "-n",
          "4096",
          "-",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
          killSignal: "SIGKILL",
        },
      ));
      const [exit, samples, stderr] = await Promise.all([
        result.exited,
        new Response(result.stdout).arrayBuffer(),
        new Response(result.stderr).text(),
      ]);
      if (cancelled) return;
      console.log(stderr.trim());
      const ok = exit === 0 && samples.byteLength === 8192;
      console.log(
        `USB sample check: ${ok ? "passed" : "FAILED"} (${samples.byteLength} bytes, exit ${exit})`,
      );
      failed ||= !ok;
    } else {
      console.error("rtl_sdr is unavailable; USB access has not been checked.");
      failed = true;
    }
    if (failed) process.exitCode = 1;
    console.log(
      "This checks tools and USB only. A received known call is required to verify RF settings.",
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (active && active.exitCode === null) active.kill("SIGKILL");
    await active?.exited;
    if (cancelled) process.exitCode = 130;
  }
}

export async function calibrate(
  secondsValue?: string,
  output = "./data/gain-survey.json",
) {
  const config = await loadConfig();
  const seconds = duration(secondsValue, 120);
  const reportPath = resolve(output);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await surveyGains({
      ...config.radio,
      durationSeconds: seconds,
      reportPath,
      onLog: console.log,
      signal: controller.signal,
    });
    console.log(report.conclusion);
    console.log(`Saved survey: ${reportPath}`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

export async function record(
  output = "./data/manual.wav",
  secondsValue?: string,
) {
  const config = await loadConfig();
  const seconds = duration(secondsValue, 60);
  const receiver = new RadioReceiver({ ...config.radio, onLog: console.log });
  const stop = () => {
    void receiver.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await receiver.start();
    const clip = await receiver.recordWav(resolve(output), seconds * 1000);
    console.log(`Saved ${clip.bytes} bytes to ${clip.path}`);
  } finally {
    await receiver.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function replay(filePath?: string) {
  const config = await loadConfig();
  if (!filePath) throw new Error("Usage: bun run replay FILE");
  let count = 0;
  const consume = (call: Page) => {
    console.log(JSON.stringify(call));
    count++;
  };
  if (filePath.toLowerCase().endsWith(".wav"))
    await replayWav(resolve(filePath), config.radio, consume);
  else {
    const file = Bun.file(filePath);
    if (file.size > 16 * 1024 * 1024)
      throw new Error("JSONL fixture exceeds 16 MiB");
    for (const line of (await file.text()).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const call = parseDecoderLine(line);
      if (!call) throw new Error("Invalid POCSAG JSONL record");
      consume(call);
    }
  }
  console.log(`Replayed ${count} decoded calls. Push alerts were disabled.`);
}

export async function addDevice(name?: string) {
  if (!name?.trim()) throw new Error('Usage: bun run device:add "Phone name"');
  const store = new Store((await loadConfig()).database);
  using _database = store.db;
  const device = store.addDevice(name.trim());
  console.log(
    `Device ID: ${device.id}\nDevice key (shown once): ${device.token}\nPaste the key into the app connection settings. Keep it private.`,
  );
}

export async function revokeDevice(id?: string) {
  if (!id) throw new Error("Usage: bun run device:revoke DEVICE_ID");
  const store = new Store((await loadConfig()).database);
  using _database = store.db;
  console.log(`Revoked ${store.revokeDevice(id)} device(s).`);
}

async function cloudClient() {
  const config = await loadConfig();
  if (!config.convex) throw new Error("Configure convex in config.json first");
  return { config, client: await ConvexClient.open(config.convex) };
}

export async function setMember(uid: string | undefined, approved: boolean) {
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid))
    throw new Error(
      `Usage: bun run member:${approved ? "approve" : "revoke"} DEVICE_UID`,
    );
  const { client } = await cloudClient();
  await client.setMember(uid, approved);
  console.log(
    `${approved ? "Approved" : "Revoked"} ${uid} for history and notifications.`,
  );
}

export async function listMembers() {
  const { client } = await cloudClient();
  for (const device of await client.devices())
    console.log(
      `${device.uid}\t${device.approved ? "approved" : "revoked"}\t${device.expoPushToken ? "push enabled" : "push disabled"}`,
    );
}

export async function syncRicUnits() {
  const { config, client } = await cloudClient();
  if (!(await Bun.file(config.database).exists()))
    throw new Error(`Database not found: ${config.database}`);
  const store = new Store(config.database, true);
  using _database = store.db;
  const units = store.ricUnits();
  await client.syncRicUnits(units);
  console.log(`RIC mappings: synchronized ${units.length}.`);
}

export async function importHistory() {
  const { config, client } = await cloudClient();
  if (!(await Bun.file(config.database).exists()))
    throw new Error(`Database not found: ${config.database}`);
  const store = new Store(config.database, true);
  using _database = store.db;
  const worker = new ConvexWorker(store, client);
  while (store.cloudMessages(worker.cursor).length) {
    await worker.tick(Date.now(), false);
    if (worker.lastError) throw new Error(worker.lastError);
  }
  await client.syncRicUnits(store.ricUnits());
  console.log(
    `History synchronized through ID ${worker.cursor}; no notifications queued.`,
  );
}

export async function backfillLocations() {
  const { config } = await cloudClient();
  if (!config.location)
    throw new Error("Configure location in config.json first");
  if (!(await Bun.file(config.database).exists()))
    throw new Error(`Database not found: ${config.database}`);
  const store = new Store(config.database, true);
  using _database = store.db;
  const result = store.db
    .query(`INSERT OR IGNORE INTO location_jobs (message_id, next_attempt)
    SELECT id, ? FROM messages WHERE type != 'tone' AND length(trim(content)) > 0`)
    .run(Date.now());
  console.log(
    `Queued ${result.changes} messages for background location extraction.`,
  );
}

export async function backup(output?: string) {
  if (!output) throw new Error("Usage: bun run backup OUTPUT_FILE");
  const config = await loadConfig();
  if (!(await Bun.file(config.database).exists()))
    throw new Error(`Database not found: ${config.database}`);
  const store = new Store(config.database);
  using _database = store.db;
  store.backup(resolve(output));
  console.log(`Saved database backup to ${resolve(output)}`);
}
function duration(value: string | undefined, fallback: number) {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600)
    throw new Error("Seconds must be between 1 and 3600");
  return seconds;
}
