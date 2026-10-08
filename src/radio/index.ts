import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  BYTES_PER_SECOND,
  CaptureWindow,
  PcmFramer,
  PcmRing,
  secondsToBytes,
  wavHeader,
  wavPcm,
} from "./audio";
import { multimonArgs, parseDecoderLine, rtlFmArgs } from "./decoder";
import type { Page, Gain, RadioConfig } from "./decoder";

export interface ClipConfig {
  enabled: boolean;
  directory: string;
  preSeconds: number;
  postSeconds: number;
  maxFiles: number;
  maxBytes: number;
  continuous?: boolean;
}

export interface AudioClip {
  path: string;
  reason: "decoded" | "continuous" | "manual";
  startedAt: string;
  endedAt: string;
  bytes: number;
  calls: Page[];
}

export interface RadioState {
  state: "stopped" | "starting" | "running" | "restarting";
  error: string | null;
  lastAudioAt: string | null;
  lastCallAt: string | null;
  restartCount: number;
}

export interface ReceiverOptions extends RadioConfig {
  audioTimeoutMs?: number;
  clips?: ClipConfig;
  onCall?: (call: Page) => void;
  onState?: (state: RadioState) => void;
  onClip?: (clip: AudioClip) => void | Promise<void>;
  onLog?: (message: string) => void;
}

interface PendingClip {
  capture: CaptureWindow;
  reason: "decoded" | "continuous";
  calls: Page[];
  startedAt: string;
}

interface ManualRecording {
  stream: WriteStream;
  path: string;
  bytes: number;
  targetBytes: number;
  startedAt: string;
  calls: Page[];
  resolve: (clip: AudioClip) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  finalizing?: Promise<AudioClip>;
}

const RTL_STARTUP_LINE =
  /^(?:Found \d+ device\(s\):|\s+\d+: .+|Using device \d+: .+|Found .+ tuner|Tuner gain set to (?:automatic|[-\d.]+ dB)\.|Tuned to \d+ Hz\.|Oversampling (?:input|output) by: \d+x\.|Buffer size: [\d.]+ms|Exact sample rate is: [\d.]+ Hz|Sampling at \d+ S\/s\.|Output at \d+ Hz\.)$/;

async function terminate(
  child: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

export class RadioReceiver {
  private rtl: ChildProcessWithoutNullStreams | undefined;
  private decoder: ChildProcessWithoutNullStreams | undefined;
  private desired = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private audioWatchdog: ReturnType<typeof setTimeout> | undefined;
  private ring = new PcmRing(0);
  private framer = new PcmFramer();
  private pending: PendingClip | undefined;
  private continuous: PendingClip | undefined;
  private manual: ManualRecording | undefined;
  private fileQueue: Promise<void> = Promise.resolve();
  private queuedClips = 0;
  private cleanup: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;
  private state: RadioState = {
    state: "stopped",
    error: null,
    lastAudioAt: null,
    lastCallAt: null,
    restartCount: 0,
  };

  constructor(private readonly options: ReceiverOptions) {
    const clips = options.clips;
    if (
      clips &&
      (!Number.isFinite(clips.preSeconds) ||
        clips.preSeconds < 0 ||
        clips.preSeconds > 120 ||
        !Number.isFinite(clips.postSeconds) ||
        clips.postSeconds < 0 ||
        clips.postSeconds > 120 ||
        !Number.isInteger(clips.maxFiles) ||
        clips.maxFiles < 1 ||
        !Number.isFinite(clips.maxBytes) ||
        clips.maxBytes < 44)
    ) {
      throw new Error("Invalid clip durations or retention limits");
    }
  }

  status(): RadioState {
    return { ...this.state };
  }

  private update(state: Partial<RadioState>): void {
    Object.assign(this.state, state);
    this.options.onState?.(this.status());
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.desired) return;
    this.desired = true;
    try {
      await this.launch();
    } catch (error) {
      await this.stop();
      this.update({ error: String(error) });
      throw error;
    }
  }

  private async launch(): Promise<void> {
    this.update({ state: "starting", error: null, lastAudioAt: null });
    this.ring = new PcmRing(
      this.options.clips?.enabled
        ? secondsToBytes(this.options.clips.preSeconds)
        : 0,
    );
    this.framer = new PcmFramer();
    const decoder = spawn(this.options.multimonPath, multimonArgs(), {
      stdio: "pipe",
      windowsHide: true,
    });
    const rtl = spawn(this.options.rtlFmPath, rtlFmArgs(this.options), {
      stdio: "pipe",
      windowsHide: true,
      // macOS libc otherwise buffers 512 KiB on Bun's socket-based stdout,
      // delaying 22050 Hz PCM by about 12 seconds. No extra utility is needed.
      env:
        process.platform === "darwin"
          ? { ...process.env, STDBUF1: "U", _STDBUF_O: "0" }
          : process.env,
    });
    this.decoder = decoder;
    this.rtl = rtl;
    rtl.stdout.on("data", (chunk: Buffer) => {
      if (rtl === this.rtl) this.audio(chunk);
    });
    rtl.stdout.pipe(decoder.stdin);
    decoder.stdin.on("error", (error) => {
      if (decoder === this.decoder)
        this.failed(`Decoder input: ${error.message}`);
    });
    const lines = createInterface({ input: decoder.stdout });
    lines.on("line", (line) => {
      if (decoder !== this.decoder) return;
      const call = parseDecoderLine(line);
      if (!call) return;
      this.state.lastCallAt = call.receivedAt;
      if (this.manual && !this.manual.finalizing) this.manual.calls.push(call);
      this.captureCall(call);
      this.options.onCall?.(call);
    });
    for (const [name, child] of [
      ["rtl_fm", rtl],
      ["multimon-ng", decoder],
    ] as const) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (!line.trim() || (name === "rtl_fm" && RTL_STARTUP_LINE.test(line)))
          return;
        this.options.onLog?.(`${name}: ${line.slice(0, 2000)}`);
      });
      child.on("error", (error) => {
        if (child === this.rtl || child === this.decoder)
          this.failed(`${name}: ${error.message}`);
      });
      child.on("close", (code, signal) => {
        if (child === this.rtl || child === this.decoder)
          this.failed(`${name} exited (${code ?? signal})`);
      });
    }
    await Promise.all([once(decoder, "spawn"), once(rtl, "spawn")]);
    if (this.desired && rtl === this.rtl && decoder === this.decoder) {
      this.audioWatchdog = setTimeout(
        () => this.failed("Receiver audio stalled: no PCM samples received"),
        this.options.audioTimeoutMs ?? 30_000,
      );
      this.update({ state: "running" });
    }
  }

  private failed(message: string): void {
    if (!this.desired || this.retry) return;
    clearTimeout(this.audioWatchdog);
    this.audioWatchdog = undefined;
    this.update({
      state: "restarting",
      error: message,
      restartCount: this.state.restartCount + 1,
    });
    const rtl = this.rtl;
    const decoder = this.decoder;
    this.rtl = this.decoder = undefined;
    this.cleanup = Promise.all([terminate(rtl), terminate(decoder)]).then(
      () => {},
    );
    this.flushClips();
    this.failRecording(new Error(message));
    const retryMs = Math.min(
      30_000,
      1_000 * 2 ** Math.min(this.state.restartCount, 5),
    );
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      await this.cleanup;
      if (!this.desired) return;
      try {
        await this.launch();
      } catch (error) {
        this.failed(String(error));
      }
    }, retryMs);
  }

  private audio(input: Buffer): void {
    const pcm = this.framer.push(input);
    if (!pcm.length) return;
    this.audioWatchdog?.refresh();
    const firstAudio = this.state.lastAudioAt === null;
    this.state.lastAudioAt = new Date().toISOString();
    if (firstAudio)
      this.options.onLog?.(`Receiver PCM resumed: ${this.state.lastAudioAt}`);
    if (this.pending?.capture.push(pcm)) {
      this.saveClip(this.pending);
      this.pending = undefined;
    }
    if (this.options.clips?.enabled && this.options.clips.continuous) {
      // Split exactly at 30 seconds, including when a native pipe chunk crosses it.
      let remaining = pcm;
      while (remaining.length) {
        this.continuous ??= {
          capture: new CaptureWindow(
            Buffer.alloc(0),
            30 * BYTES_PER_SECOND,
            30 * BYTES_PER_SECOND,
          ),
          reason: "continuous",
          calls: [],
          startedAt: new Date().toISOString(),
        };
        const before = this.continuous.capture.byteLength;
        const take = Math.min(remaining.length, 30 * BYTES_PER_SECOND - before);
        if (this.continuous.capture.push(remaining.subarray(0, take))) {
          this.saveClip(this.continuous);
          this.continuous = undefined;
        }
        remaining = remaining.subarray(take);
      }
    }
    this.ring.push(pcm);
    const recording = this.manual;
    if (recording && !recording.finalizing) {
      const take = Math.min(
        pcm.length,
        recording.targetBytes - recording.bytes,
      );
      recording.stream.write(pcm.subarray(0, take));
      recording.bytes += take;
      if (recording.stream.writableLength > 10 * BYTES_PER_SECOND)
        this.failRecording(new Error("Recording disk cannot keep up"));
      else if (recording.bytes >= recording.targetBytes)
        void this.finishRecording();
    }
  }

  private captureCall(call: Page): void {
    const config = this.options.clips;
    if (!config?.enabled) return;
    if (this.pending) {
      this.pending.calls.push(call);
      this.pending.capture.extend(secondsToBytes(config.postSeconds));
    } else {
      const pre = this.ring.snapshot();
      this.pending = {
        capture: new CaptureWindow(
          pre,
          secondsToBytes(config.postSeconds),
          secondsToBytes(Math.max(30, config.preSeconds + config.postSeconds)),
        ),
        reason: "decoded",
        calls: [call],
        startedAt: new Date(
          Date.now() - (pre.length / BYTES_PER_SECOND) * 1_000,
        ).toISOString(),
      };
    }
    if (this.continuous) this.continuous.calls.push(call);
    if (!config.postSeconds && this.pending) {
      this.saveClip(this.pending);
      this.pending = undefined;
    }
  }

  private saveClip(pending: PendingClip): void {
    const config = this.options.clips!;
    if (!pending.capture.byteLength) return;
    // Avoid an unbounded write backlog if storage stalls while receiving.
    if (this.queuedClips >= 8) {
      this.options.onLog?.(
        "Skipped audio clip: eight writes are already pending",
      );
      return;
    }
    const pcm = pending.capture.finish();
    const { reason, startedAt, calls } = pending;
    const endedAt = this.state.lastAudioAt!;
    this.queuedClips++;
    this.fileQueue = this.fileQueue
      .then(async () => {
        try {
          await mkdir(config.directory, { recursive: true });
          const path = join(
            config.directory,
            `subpager-${reason}-${endedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.wav`,
          );
          await writeFile(path, Buffer.concat([wavHeader(pcm.length), pcm]), {
            flag: "wx",
            mode: 0o600,
          });
          const clip: AudioClip = {
            path,
            reason,
            startedAt,
            endedAt,
            bytes: pcm.length + 44,
            calls,
          };
          await this.writeMetadata(clip);
          await this.options.onClip?.(clip);
        } finally {
          await pruneClips(config.directory, config.maxFiles, config.maxBytes);
        }
      })
      .catch((error) =>
        this.options.onLog?.(`Clip write failed: ${String(error)}`),
      )
      .finally(() => {
        this.queuedClips--;
      });
  }

  private async writeMetadata(clip: AudioClip): Promise<void> {
    const { frequencyHz, device, gain, ppm, rtlFmPath, multimonPath } =
      this.options;
    await writeFile(
      `${clip.path}.json`,
      JSON.stringify(
        {
          ...clip,
          sampleRate: 22_050,
          format: "PCM16 mono little-endian",
          decoderVersion: "expected 1.6.1",
          radio: { frequencyHz, device, gain, ppm, rtlFmPath, multimonPath },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }

  private flushClips(): void {
    if (this.pending) this.saveClip(this.pending);
    if (this.continuous) this.saveClip(this.continuous);
    this.pending = this.continuous = undefined;
  }

  async recordWav(path: string, durationMs: number): Promise<AudioClip> {
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > 3_600_000
    )
      throw new Error("Recording duration must be between 0 and 3600 seconds");
    await mkdir(dirname(path), { recursive: true });
    if (!this.desired || this.stopping || this.state.state !== "running")
      throw new Error("Receiver must be running to record");
    if (this.manual) throw new Error("A manual recording is already active");
    return new Promise((resolve, reject) => {
      const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
      const timeout = setTimeout(
        () =>
          this.failRecording(
            new Error("Timed out waiting for receiver samples"),
            recording,
          ),
        durationMs + 15_000,
      );
      const recording: ManualRecording = {
        stream,
        path,
        bytes: 0,
        targetBytes: secondsToBytes(durationMs / 1_000),
        startedAt: new Date().toISOString(),
        calls: [],
        resolve,
        reject,
        timeout,
      };
      this.manual = recording;
      stream.on("error", (error) => this.failRecording(error, recording));
      stream.write(wavHeader(0));
    });
  }

  private async finishRecording(): Promise<void> {
    const recording = this.manual;
    if (!recording || recording.finalizing) return;
    clearTimeout(recording.timeout);
    recording.finalizing = (async () => {
      const finished = once(recording.stream, "finish");
      recording.stream.end();
      await finished;
      const file = await open(recording.path, "r+");
      try {
        await file.write(wavHeader(recording.bytes), 0, 44, 0);
      } finally {
        await file.close();
      }
      const clip: AudioClip = {
        path: recording.path,
        reason: "manual",
        startedAt: recording.startedAt,
        endedAt: new Date().toISOString(),
        bytes: recording.bytes + 44,
        calls: recording.calls,
      };
      await this.writeMetadata(clip);
      return clip;
    })();
    try {
      const clip = await recording.finalizing;
      await this.options.onClip?.(clip);
      recording.resolve(clip);
    } catch (error) {
      recording.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      if (this.manual === recording) this.manual = undefined;
    }
  }

  private failRecording(error: Error, recording = this.manual): void {
    if (!recording || recording !== this.manual || recording.finalizing) return;
    this.manual = undefined;
    clearTimeout(recording.timeout);
    recording.stream.destroy();
    recording.reject(error);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.desired = false;
    clearTimeout(this.audioWatchdog);
    this.audioWatchdog = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const rtl = this.rtl;
    const decoder = this.decoder;
    this.rtl = this.decoder = undefined;
    this.failRecording(
      new Error("Receiver stopped before recording completed"),
    );
    const finalizing = this.manual?.finalizing;
    this.stopping = (async () => {
      await Promise.all([terminate(rtl), terminate(decoder)]);
      await this.cleanup;
      // The archive callback can await stop; wait only for WAV and metadata writes.
      await finalizing?.catch(() => {});
      this.flushClips();
      await this.fileQueue;
      this.update({ state: "stopped" });
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}

export async function pruneClips(
  directory: string,
  maxFiles: number,
  maxBytes: number,
): Promise<void> {
  const entries = await readdir(directory);
  const names = entries.filter((name) =>
    /^subpager-(decoded|continuous)-.*\.wav$/.test(name),
  );
  for (const name of entries) {
    if (
      /^subpager-(decoded|continuous)-.*\.wav\.json$/.test(name) &&
      !entries.includes(name.slice(0, -5))
    ) {
      await rm(join(directory, name), { force: true });
    }
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const wav = await stat(join(directory, name));
      let metadataBytes = 0;
      try {
        metadataBytes = (await stat(join(directory, `${name}.json`))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        name,
        size: wav.size + metadataBytes,
        mtimeMs: wav.mtimeMs,
        continuous: name.startsWith("subpager-continuous-"),
      };
    }),
  );
  files.sort(
    (a, b) =>
      Number(b.continuous) - Number(a.continuous) ||
      a.mtimeMs - b.mtimeMs ||
      a.name.localeCompare(b.name),
  );
  let bytes = files.reduce((total, file) => total + file.size, 0);
  let count = files.length;
  for (const file of files) {
    if (count <= maxFiles && bytes <= maxBytes) break;
    await unlink(join(directory, file.name));
    await rm(join(directory, `${file.name}.json`), { force: true });
    bytes -= file.size;
    count--;
  }
}

export async function replayWav(
  path: string,
  options: Pick<RadioConfig, "multimonPath"> & {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  onCall?: (call: Page) => void,
): Promise<Page[]> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Replay timeout must be positive");
  // Read only bounded debug captures; the file stays below a standard one-hour recording.
  if ((await stat(path)).size > 3_600 * BYTES_PER_SECOND + 65_536)
    throw new Error("Replay WAV exceeds one hour");
  const pcm = wavPcm(await readFile(path));
  options.signal?.throwIfAborted();
  const decoder = spawn(options.multimonPath, multimonArgs(), {
    stdio: "pipe",
    windowsHide: true,
  });
  const calls: Page[] = [];
  let stderr = "";
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  decoder.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  createInterface({ input: decoder.stdout }).on("line", (line) => {
    const call = parseDecoderLine(line);
    if (call) {
      calls.push(call);
      try {
        onCall?.(call);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  decoder.once("error", reject);
  decoder.stdin.once("error", reject);
  decoder.once("close", (code) =>
    code === 0
      ? resolve()
      : reject(
          new Error(
            `Decoder replay failed (${code}): ${JSON.stringify(stderr.slice(-2000))}`,
          ),
        ),
  );
  const timeout = setTimeout(
    () => reject(new Error(`Decoder replay timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const abort = () => reject(new Error("Decoder replay cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    decoder.stdin.end(pcm);
    await promise;
    return calls;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await terminate(decoder);
  }
}

export interface GainSurveyOptions extends RadioConfig {
  gains?: Gain[];
  durationSeconds?: number;
  reportPath: string;
  onLog?: (message: string) => void;
  captureDirectory?: string;
  signal?: AbortSignal;
}

export async function surveyGains(
  options: GainSurveyOptions,
): Promise<GainSurveyReport> {
  const gains = options.gains ?? ["auto", 14.4, 28, 40.2];
  const durationSeconds = options.durationSeconds ?? 120;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !gains.length
  )
    throw new Error("Gain survey requires gains and a positive duration");
  const report: GainSurveyReport = {
    startedAt: new Date().toISOString(),
    frequencyHz: options.frequencyHz,
    device: options.device,
    durationSeconds,
    appliedGain: null,
    interrupted: false,
    conclusion:
      "Sequential live traffic is not comparable RF evidence. No gain has been selected or applied. Compare repeated known test pages and saved WAVs before changing configuration.",
    candidates: [],
  };
  const surveyDirectory =
    options.captureDirectory ??
    join(
      dirname(options.reportPath),
      `gain-clips-${report.startedAt.replace(/[:.]/g, "-")}`,
    );
  await mkdir(dirname(options.reportPath), { recursive: true });
  const persist = () =>
    writeFile(options.reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  for (const gain of gains) {
    if (options.signal?.aborted) {
      report.interrupted = true;
      break;
    }
    const captureDirectory = join(
      surveyDirectory,
      `gain-${gain}-${report.candidates.length + 1}`,
    );
    const candidate: GainSurveyReport["candidates"][number] = {
      gain,
      startedAt: new Date().toISOString(),
      decodedCalls: 0,
      uniqueMessages: 0,
      rics: [],
      receiverError: null,
      captureDirectory,
      clipPaths: [],
    };
    const messages = new Set<string>();
    const rics = new Set<number>();
    const receiver = new RadioReceiver({
      ...options,
      gain,
      clips: {
        enabled: true,
        directory: captureDirectory,
        preSeconds: 8,
        postSeconds: 4,
        continuous: true,
        maxFiles: 60,
        maxBytes: 256 * 1024 * 1024,
      },
      onCall: (call) => {
        candidate.decodedCalls++;
        messages.add(JSON.stringify([call.ric, call.function, call.content]));
        rics.add(call.ric);
      },
      onState: (state) => {
        if (state.error) candidate.receiverError = state.error;
      },
    });
    options.onLog?.(
      `Listening at gain ${gain} for ${durationSeconds} seconds. Use repeated known test pages for a meaningful comparison.`,
    );
    try {
      await receiver.start();
      await delay(durationSeconds * 1_000, undefined, {
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) report.interrupted = true;
      else candidate.receiverError = String(error);
    } finally {
      await receiver.stop();
    }
    candidate.uniqueMessages = messages.size;
    candidate.rics = [...rics];
    report.candidates.push(candidate);
    candidate.clipPaths = (await readdir(captureDirectory).catch(() => []))
      .filter((name) => name.endsWith(".wav"))
      .map((name) => join(captureDirectory, name));
    // Persist progress so an interrupted survey retains completed candidates.
    await persist();
    if (report.interrupted) break;
  }
  await persist();
  return report;
}

export interface GainSurveyReport {
  startedAt: string;
  frequencyHz: number;
  device: string | number;
  durationSeconds: number;
  appliedGain: null;
  interrupted: boolean;
  conclusion: string;
  candidates: {
    gain: Gain;
    startedAt: string;
    decodedCalls: number;
    uniqueMessages: number;
    rics: number[];
    receiverError: string | null;
    captureDirectory: string;
    clipPaths: string[];
  }[];
}
