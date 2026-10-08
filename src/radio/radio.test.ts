import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BYTES_PER_SECOND,
  CaptureWindow,
  PcmFramer,
  PcmRing,
  wavHeader,
  wavPcm,
} from "./audio";
import { parseDecoderLine, rtlFmArgs } from "./decoder";
import { pruneClips, RadioReceiver, replayWav, surveyGains } from "./index";
import { setTimeout as delay } from "node:timers/promises";
import type { WriteStream } from "node:fs";
import type { Page } from "./decoder";
import type { AudioClip, RadioState, ReceiverOptions } from "./index";

const defaultOptions: ReceiverOptions = {
  frequencyHz: 173_250_000,
  device: "0",
  gain: "auto",
  ppm: 0,
  rtlFmPath: "unused simulated receiver",
  multimonPath: "unused simulated decoder",
};

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o755);
}

function simulatedReceiver(options: Partial<ReceiverOptions> = {}) {
  const receiver = new RadioReceiver({
    ...defaultOptions,
    ...options,
  });
  const internal = receiver as unknown as {
    desired: boolean;
    state: RadioState;
    manual?: { stream: WriteStream };
    audio(pcm: Buffer): void;
    captureCall(call: Page): void;
    writeMetadata(clip: AudioClip): Promise<void>;
    fileQueue: Promise<void>;
    queuedClips: number;
  };
  internal.desired = true;
  internal.state.state = "running";
  return { receiver, internal };
}

async function recordingStream(
  internal: ReturnType<typeof simulatedReceiver>["internal"],
) {
  for (let attempt = 0; attempt < 100 && !internal.manual; attempt++)
    await delay(10);
  expect(internal.manual).toBeDefined();
  return internal.manual!.stream;
}

test("concurrent recording setups keep one owner, and stop cancels unfinished setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-record-setup-"));
  const { receiver, internal } = simulatedReceiver();
  try {
    const first = receiver.recordWav(join(directory, "first.wav"), 1);
    const second = receiver.recordWav(join(directory, "second.wav"), 1);
    const rejected = await Promise.race([
      first.catch((error) => error),
      second.catch((error) => error),
    ]);
    expect(rejected.message).toBe("A manual recording is already active");
    internal.audio(Buffer.alloc(44));
    const results = await Promise.allSettled([first, second]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".wav")),
    ).toHaveLength(1);

    const setup = receiver
      .recordWav(join(directory, "stopped.wav"), 1)
      .catch((error) => error);
    await receiver.stop();
    expect((await setup).message).toContain("Receiver must be running");
    expect(await readdir(directory)).not.toContain("stopped.wav");
  } finally {
    await receiver.stop();
    await rm(directory, { recursive: true });
  }
});

test("manual ownership lasts through the awaited archive callback and ignores old stream errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-record-finalize-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { receiver, internal } = simulatedReceiver({
    onClip: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("Archive unavailable");
    },
  });
  try {
    let settled = false;
    const recording = receiver.recordWav(join(directory, "first.wav"), 1);
    void recording.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const oldStream = await recordingStream(internal);
    internal.audio(Buffer.alloc(44));
    await entered.promise;
    expect(settled).toBe(false);
    await expect(
      receiver.recordWav(join(directory, "overlap.wav"), 1),
    ).rejects.toThrow("already active");
    release.resolve();
    await expect(recording).rejects.toThrow("Archive unavailable");

    const next = receiver
      .recordWav(join(directory, "next.wav"), 1)
      .catch((error) => error);
    const newStream = await recordingStream(internal);
    oldStream.emit("error", new Error("Late old stream failure"));
    expect(internal.manual?.stream).toBe(newStream);
    await receiver.stop();
    expect((await next).message).toContain("Receiver stopped");
  } finally {
    release.resolve();
    await receiver.stop();
    await rm(directory, { recursive: true });
  }
});

test("stop waits for manual WAV finalization while its callback can await stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-record-stop-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let callbackDone = false;
  const { receiver, internal } = simulatedReceiver({
    onClip: async () => {
      await receiver.stop();
      callbackDone = true;
    },
  });
  const writeMetadata = internal.writeMetadata.bind(receiver);
  internal.writeMetadata = async (clip) => {
    entered.resolve();
    await release.promise;
    await writeMetadata(clip);
  };
  try {
    const recording = receiver.recordWav(join(directory, "manual.wav"), 1);
    await recordingStream(internal);
    internal.audio(Buffer.alloc(44));
    await entered.promise;
    let stopped = false;
    const stopping = receiver.stop();
    expect(receiver.stop()).toBe(stopping);
    void stopping.then(() => {
      stopped = true;
    });
    await delay(10);
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    const clip = await recording;
    expect(callbackDone).toBe(true);
    expect(wavPcm(await readFile(clip.path))).toHaveLength(44);
    expect(JSON.parse(await readFile(`${clip.path}.json`, "utf8")).bytes).toBe(
      88,
    );
  } finally {
    release.resolve();
    await receiver.stop();
    await rm(directory, { recursive: true });
  }
});

describe("raw audio capture", () => {
  test("preserves samples when native chunks split a 16-bit sample", () => {
    const framing = new PcmFramer();
    const chunks = [
      Buffer.from([1]),
      Buffer.from([2, 3, 4]),
      Buffer.from([5, 6, 7]),
      Buffer.from([8]),
    ];
    expect(Buffer.concat(chunks.map((chunk) => framing.push(chunk)))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    );
  });

  test("ring preserves only the latest samples across wraps and oversized input", () => {
    const ring = new PcmRing(6);
    ring.push(Buffer.from([1, 2, 3, 4]));
    expect(ring.snapshot()).toEqual(Buffer.from([1, 2, 3, 4]));
    ring.push(Buffer.from([5, 6, 7, 8]));
    expect(ring.snapshot()).toEqual(Buffer.from([3, 4, 5, 6, 7, 8]));
    ring.push(Buffer.from([9, 10, 11, 12, 13, 14, 15, 16]));
    expect(ring.snapshot()).toEqual(Buffer.from([11, 12, 13, 14, 15, 16]));
    ring.push(Buffer.from([17, 18, 19, 20, 21, 22, 23, 24]));
    expect(ring.snapshot()).toEqual(Buffer.from([19, 20, 21, 22, 23, 24]));
    ring.push(Buffer.from([25, 26]));
    expect(ring.snapshot()).toEqual(Buffer.from([21, 22, 23, 24, 25, 26]));
    ring.push(Buffer.from([27, 28, 29, 30, 31, 32]));
    expect(ring.snapshot()).toEqual(Buffer.from([27, 28, 29, 30, 31, 32]));
  });

  test("a clip contains pre-trigger samples and only the requested post-trigger samples", () => {
    const pre = Buffer.from([1, 2, 3, 4]);
    const post = Buffer.from([5, 6]);
    const capture = new CaptureWindow(pre, 4, 12);
    pre.fill(0);
    expect(capture.push(post)).toBe(false);
    post.fill(0);
    expect(capture.push(Buffer.from([7, 8, 9, 10]))).toBe(true);
    const clip = capture.finish();
    expect(clip).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(clip.buffer.byteLength).toBe(clip.length);
    clip.fill(0);
    expect(capture.finish()).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  test("nearby triggers extend post capture without exceeding its memory limit", () => {
    const capture = new CaptureWindow(Buffer.from([1, 2]), 4, 8);
    capture.push(Buffer.from([3, 4]));
    capture.extend(8);
    expect(capture.push(Buffer.from([5, 6, 7, 8, 9, 10]))).toBe(true);
    expect(capture.finish()).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  test("WAV header matches captured bytes, and metadata chunks do not alter replay", () => {
    const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wavPcm(wav)).toEqual(pcm);
    for (const offset of [0, 8, 12, 36]) {
      const invalid = Buffer.from(wav);
      invalid[offset]! |= 0x80;
      expect(() => wavPcm(invalid)).toThrow();
    }
    const metadata = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 42, 0]);
    const withMetadata = Buffer.concat([
      wav.subarray(0, 36),
      metadata,
      wav.subarray(36),
    ]);
    withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
    expect(wavPcm(withMetadata)).toEqual(pcm);
    const duplicate = Buffer.concat([wav, wav.subarray(36)]);
    duplicate.writeUInt32LE(duplicate.length - 8, 4);
    expect(() => wavPcm(duplicate)).toThrow("multiple data chunks");
  });

  test("replay rejects incompatible formats and truncated captures", () => {
    const wav = Buffer.concat([wavHeader(2), Buffer.alloc(2)]);
    expect(() => wavPcm(wav.subarray(0, 45))).toThrow("Truncated");
    for (let length = 1; length < 8; length++) {
      const incomplete = Buffer.concat([wav, Buffer.alloc(length)]);
      incomplete.writeUInt32LE(incomplete.length - 8, 4);
      expect(() => wavPcm(incomplete)).toThrow("Truncated WAV chunk header");
    }
    const metadata = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 42]);
    for (const padding of [Buffer.alloc(0), Buffer.alloc(1)]) {
      const unpadded = Buffer.concat([wav, metadata, padding]);
      unpadded.writeUInt32LE(unpadded.length - padding.length - 8, 4);
      expect(() => wavPcm(unpadded)).toThrow("Truncated WAV chunk");
    }
    const odd = Buffer.from(wav);
    odd.writeUInt32LE(1, 40);
    expect(() => wavPcm(odd)).toThrow("incomplete 16-bit sample");
    const badByteRate = Buffer.from(wav);
    badByteRate.writeUInt32LE(0, 28);
    expect(() => wavPcm(badByteRate)).toThrow("PCM16 mono");
    wav.writeUInt32LE(48_000, 24);
    expect(() => wavPcm(wav)).toThrow("PCM16 mono");
    expect(() => wavHeader(3)).toThrow("complete 16-bit");
  });
});

describe("decoder integration contract", () => {
  test("preserves Slovenian characters and raw termination markers", () => {
    const line = JSON.stringify({
      demod_name: "POCSAG1200",
      address: 791393,
      function: 3,
      alpha: "ŽŠČ žšč<EOT><NUL>",
    });
    const call = parseDecoderLine(line, "2026-10-07T10:00:00.000Z")!;
    expect(call.content).toBe("ŽŠČ žšč<EOT><NUL>");
    expect(call.ric).toBe(791393);
    expect(call.receivedAt).toBe("2026-10-07T10:00:00.000Z");
  });

  test("keeps decoded markers and whitespace for cloud normalization", () => {
    for (const ending of ["<EOT><NUL>", "<EOT>", "<NUL>", "\x04\x00"]) {
      const call = parseDecoderLine(
        JSON.stringify({
          demod_name: "POCSAG1200",
          address: 42,
          function: 3,
          alpha: ` ČŠŽ<NUL> inside ${ending}`,
        }),
      )!;
      expect(call.content).toBe(` ČŠŽ<NUL> inside ${ending}`);
    }
  });

  test("preserves rendered and raw line breaks for cloud normalization", () => {
    for (const separator of ["<LF>", "<CR><LF>", "<CR>", "\n", "\r\n", "\r"]) {
      const call = parseDecoderLine(
        JSON.stringify({
          demod_name: "POCSAG1200",
          address: 42,
          function: 3,
          alpha: ` Test pozivnika.${separator}Prejem javi operativnemu vodji. <EOT><NUL>`,
        }),
      )!;
      expect(call.content).toBe(
        ` Test pozivnika.${separator}Prejem javi operativnemu vodji. <EOT><NUL>`,
      );
    }
  });

  test("retains tone-only and numeric calls but rejects malformed or partial addresses", () => {
    expect(
      parseDecoderLine('{"demod_name":"POCSAG1200","address":42,"function":0}')
        ?.type,
    ).toBe("tone");
    expect(
      parseDecoderLine(
        '{"demod_name":"POCSAG1200","address":42,"function":0,"numeric":"123"}',
      )?.type,
    ).toBe("numeric");
    expect(
      parseDecoderLine(
        '{"demod_name":"POCSAG1200","address":null,"function":null,"alpha":"partial"}',
      ),
    ).toBeNull();
    expect(
      parseDecoderLine(
        '{"demod_name":"POCSAG1200","address":2097152,"function":3}',
      ),
    ).toBeNull();
    expect(parseDecoderLine("Decoder startup banner")).toBeNull();
  });

  test("auto gain uses receiver default while manual gain is an explicit argument", () => {
    const config = {
      frequencyHz: 173_250_000,
      device: "test device",
      gain: "auto" as const,
      ppm: 0,
      rtlFmPath: "rtl_fm",
      multimonPath: "multimon-ng",
    };
    expect(rtlFmArgs(config)).not.toContain("-g");
    expect(rtlFmArgs({ ...config, gain: 28 })).toContain("28");
    expect(rtlFmArgs(config).slice(0, 2)).toEqual(["-d", "test device"]);
  });
});

test("continuous chunks split across boundaries with at most eight queued writes and no empty clips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-clip-backlog-"));
  const clips: AudioClip[] = [];
  const logs: string[] = [];
  const { receiver, internal } = simulatedReceiver({
    clips: {
      enabled: true,
      continuous: true,
      directory,
      preSeconds: 0,
      postSeconds: 0,
      maxFiles: 10,
      maxBytes: 20_000_000,
    },
    onClip: (clip) => {
      clips.push(clip);
    },
    onLog: (line) => logs.push(line),
  });
  const call = parseDecoderLine(
    '{"demod_name":"POCSAG1200","address":42,"function":0}',
  )!;
  const samples = Array.from({ length: 9 }, (_, index) =>
    Buffer.alloc(30 * BYTES_PER_SECOND, index + 1),
  );
  const tail = Buffer.from([42, 43]);
  try {
    internal.captureCall(call);
    expect(internal.queuedClips).toBe(0);
    internal.audio(Buffer.concat([...samples, tail]));
    expect(internal.queuedClips).toBe(8);
    internal.captureCall(call);
    expect(
      logs.filter((line) => line.startsWith("Skipped audio clip:")),
    ).toHaveLength(1);
    await internal.fileQueue;
    expect(clips).toHaveLength(8);
    expect(internal.queuedClips).toBe(0);
    for (const [index, clip] of clips.entries())
      expect(wavPcm(await readFile(clip.path))).toEqual(samples[index]!);
    await receiver.stop();
    expect(clips).toHaveLength(9);
    expect(wavPcm(await readFile(clips[8]!.path))).toEqual(tail);
  } finally {
    await receiver.stop();
    await rm(directory, { recursive: true });
  }
});

test("a survey cancelled before its first candidate still writes an unapplied report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-aborted-survey-"));
  const reportPath = join(directory, "reports", "survey.json");
  try {
    const report = await surveyGains({
      ...defaultOptions,
      reportPath,
      signal: AbortSignal.abort(),
    });
    expect(report.interrupted).toBe(true);
    expect(report.appliedGain).toBeNull();
    expect(report.candidates).toEqual([]);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("retention counts sidecar bytes without deleting manual or unrelated WAVs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-retention-"));
  try {
    await writeFile(
      join(directory, "subpager-decoded-old.wav"),
      Buffer.alloc(100),
    );
    await utimes(join(directory, "subpager-decoded-old.wav"), 1, 1);
    await writeFile(
      join(directory, "subpager-continuous-new.wav"),
      Buffer.alloc(100),
    );
    await writeFile(join(directory, "manual.wav"), Buffer.alloc(100));
    await writeFile(join(directory, "subpager-decoded-old.wav.json"), "{}");
    await pruneClips(directory, 1, 102);
    expect((await readdir(directory)).length).toBe(3);
    expect(await readdir(directory)).toContain("manual.wav");
    expect(await readdir(directory)).toContain("subpager-decoded-old.wav");
    await pruneClips(directory, 1, 101);
    expect(await readdir(directory)).toEqual(["manual.wav"]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("retention removes owned orphan sidecars and preserves other metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-orphan-sidecars-"));
  try {
    for (const name of [
      "subpager-decoded-orphan.wav.json",
      "subpager-continuous-orphan.wav.json",
      "subpager-decoded-kept.wav",
      "subpager-decoded-kept.wav.json",
      "manual.wav.json",
      "unrelated.json",
    ])
      await writeFile(join(directory, name), "");
    await pruneClips(directory, 1, 100);
    expect((await readdir(directory)).sort()).toEqual([
      "manual.wav.json",
      "subpager-decoded-kept.wav",
      "subpager-decoded-kept.wav.json",
      "unrelated.json",
    ]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test.each(["metadata", "callback"])(
  "retention still runs after a %s failure and keeps bounded staging files",
  async (failure) => {
    const directory = await mkdtemp(
      join(tmpdir(), "subpager-archive-failure-"),
    );
    const logs: string[] = [];
    const { receiver, internal } = simulatedReceiver({
      clips: {
        enabled: true,
        directory,
        preSeconds: 0,
        postSeconds: 0.001,
        maxFiles: 1,
        maxBytes: 10_000,
      },
      onClip: () => {
        throw new Error("Archive unavailable");
      },
      onLog: (line) => logs.push(line),
    });
    if (failure === "metadata")
      internal.writeMetadata = async () => {
        throw new Error("Metadata unavailable");
      };
    try {
      const old = join(directory, "subpager-decoded-old.wav");
      await writeFile(old, Buffer.concat([wavHeader(2), Buffer.alloc(2)]));
      await writeFile(`${old}.json`, "{}");
      await utimes(old, 1, 1);
      internal.captureCall(
        parseDecoderLine(
          '{"demod_name":"POCSAG1200","address":42,"function":3,"alpha":"test"}',
        )!,
      );
      internal.audio(Buffer.alloc(44));
      await internal.fileQueue;
      expect(internal.queuedClips).toBe(0);
      const entries = await readdir(directory);
      const wavs = entries.filter((name) => name.endsWith(".wav"));
      expect(wavs).toHaveLength(1);
      expect(entries).not.toContain("subpager-decoded-old.wav");
      expect(entries).not.toContain("subpager-decoded-old.wav.json");
      expect(wavPcm(await readFile(join(directory, wavs[0]!)))).toHaveLength(
        44,
      );
      if (failure === "callback") {
        const metadata = JSON.parse(
          await readFile(join(directory, `${wavs[0]}.json`), "utf8"),
        );
        expect(metadata.calls[0].ric).toBe(42);
      }
      expect(logs.some((line) => line.startsWith("Clip write failed:"))).toBe(
        true,
      );
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "receiver hides routine tuner startup but preserves unexpected child diagnostics",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-radio-logs-"));
    const rtlPath = join(directory, "receiver");
    const decoderPath = join(directory, "decoder");
    const startup = [
      "Found 1 device(s):",
      "  0:  Nooelec, NESDR SMArt v5, SN: 00000001",
      "",
      "Using device 0: Generic RTL2832U OEM",
      "Found Rafael Micro R820T tuner",
      "Tuner gain set to automatic.",
      "Tuner gain set to 28.00 dB.",
      "Tuned to 173503575 Hz.",
      "Oversampling input by: 46x.",
      "Oversampling output by: 1x.",
      "Buffer size: 8.08ms",
      "Exact sample rate is: 1014300.020041 Hz",
      "Sampling at 1014300 S/s.",
      "Output at 22050 Hz.",
    ];
    await writeExecutable(
      rtlPath,
      `process.stderr.write(${JSON.stringify(startup.join("\n") + "\nUSB read failed\n")}); setInterval(() => process.stdout.write(Buffer.alloc(2)), 20);\n`,
    );
    await writeExecutable(
      decoderPath,
      `process.stderr.write("decoder diagnostic\\n"); for await (const chunk of Bun.stdin.stream()) {}\n`,
    );
    const logs: string[] = [];
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: rtlPath,
      multimonPath: decoderPath,
      onLog: (line) => logs.push(line),
    });
    try {
      await receiver.start();
      for (
        let attempt = 0;
        attempt < 100 && !logs.includes("multimon-ng: decoder diagnostic");
        attempt++
      )
        await delay(10);
      expect(logs.filter((line) => line.startsWith("rtl_fm:"))).toEqual([
        "rtl_fm: USB read failed",
      ]);
      expect(logs.filter((line) => line.startsWith("multimon-ng:"))).toEqual([
        "multimon-ng: decoder diagnostic",
      ]);
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "native pipe capture, sidecars, manual recording and replay use the same samples",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager radio "));
    const rtlPath = join(directory, "fake receiver");
    const decoderPath = join(directory, "fake decoder");
    const call = {
      demod_name: "POCSAG1200",
      address: 42,
      function: 3,
      alpha: "ŽŠČ",
    };
    await writeExecutable(
      rtlPath,
      `const timer = setInterval(() => process.stdout.write(Buffer.alloc(8820, 42)), 20);\n`,
    );
    await writeExecutable(
      decoderPath,
      `let sent = false; for await (const chunk of Bun.stdin.stream()) { if (!sent && chunk.length) { sent = true; console.log(${JSON.stringify(JSON.stringify(call))}); } }\n`,
    );
    const clips: AudioClip[] = [];
    const calls: Page[] = [];
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: rtlPath,
      multimonPath: decoderPath,
      clips: {
        enabled: true,
        directory: join(directory, "clips"),
        preSeconds: 0.2,
        postSeconds: 0.2,
        maxFiles: 10,
        maxBytes: 1_000_000,
      },
      onCall: (value) => calls.push(value),
      onClip: (clip) => {
        clips.push(clip);
      },
    });
    try {
      await receiver.start();
      const manual = await receiver.recordWav(
        join(directory, "manual.wav"),
        200,
      );
      await delay(100);
      await receiver.stop();
      expect(calls[0]?.content).toBe("ŽŠČ");
      expect(wavPcm(await readFile(manual.path))).toEqual(
        Buffer.alloc(8820, 42),
      );
      const decoded = clips.find((clip) => clip.reason === "decoded")!;
      expect(decoded).toBeDefined();
      const metadata = JSON.parse(
        await readFile(`${decoded.path}.json`, "utf8"),
      );
      expect(metadata.radio.gain).toBe("auto");
      expect(metadata.calls[0].ric).toBe(42);
      expect(
        wavPcm(await readFile(decoded.path)).length,
      ).toBeGreaterThanOrEqual(8820);
      expect(
        (await replayWav(manual.path, { multimonPath: decoderPath }))[0]
          ?.content,
      ).toBe("ŽŠČ");
      expect(receiver.status().state).toBe("stopped");
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "recording refuses an existing file without changing it",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "subpager-exclusive-recording-"),
    );
    const executable = join(directory, "silent child");
    await writeExecutable(executable, `setInterval(() => {}, 1000);\n`);
    const path = join(directory, "existing.wav");
    const original = Buffer.from("an existing recording");
    await writeFile(path, original);
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: executable,
      multimonPath: executable,
    });
    try {
      await receiver.start();
      await expect(receiver.recordWav(path, 200)).rejects.toThrow();
      expect(await readFile(path)).toEqual(original);
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "overlapping stops share cleanup and start waits for failed children to exit",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-restart-stop-"));
    const rtlPath = join(directory, "receiver");
    const decoderPath = join(directory, "decoder");
    const pidPath = join(directory, "receiver.pid");
    await writeExecutable(
      rtlPath,
      `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => process.stdout.write(Buffer.alloc(2)), 10);\n`,
    );
    await writeExecutable(
      decoderPath,
      `setTimeout(() => process.exit(1), 300);\n`,
    );
    const { promise: failed, resolve: restarting } =
      Promise.withResolvers<void>();
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: rtlPath,
      multimonPath: decoderPath,
      onState: (state) => {
        if (state.state === "restarting") restarting();
      },
    });
    let pid: number | undefined;
    try {
      await receiver.start();
      await failed;
      pid = Number(await readFile(pidPath, "utf8"));
      const stopping = receiver.stop();
      expect(receiver.stop()).toBe(stopping);
      const starting = receiver.start();
      await delay(30);
      expect(receiver.status().state).toBe("restarting");
      expect(Number(await readFile(pidPath, "utf8"))).toBe(pid);
      await Promise.all([stopping, starting]);
      expect(receiver.status().state).toBe("running");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await receiver.stop();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "missing PCM restarts living children and stop reaps them",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-audio-stall-"));
    const executable = join(directory, "idle child");
    const pidsPath = join(directory, "children.jsonl");
    await writeExecutable(
      executable,
      `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(pidsPath)}, String(process.pid) + "\\n"); setInterval(() => {}, 1000);\n`,
    );
    const { promise: failed, resolve: restarting } =
      Promise.withResolvers<void>();
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: executable,
      multimonPath: executable,
      audioTimeoutMs: 500,
      onState: (state) => {
        if (state.state === "restarting") restarting();
      },
    });
    try {
      await receiver.start();
      await failed;
      expect(receiver.status().error).toContain("audio stalled");
      expect(receiver.status().restartCount).toBe(1);
      const pids = (await readFile(pidsPath, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(2);
      await receiver.stop();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      await delay(550);
      expect(receiver.status().state).toBe("stopped");
      expect(receiver.status().restartCount).toBe(1);
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a stalled partial continuous clip ends at its last PCM samples",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-stalled-clip-"));
    const rtlPath = join(directory, "receiver");
    const decoderPath = join(directory, "decoder");
    await writeExecutable(
      rtlPath,
      `process.stdout.write(Buffer.alloc(8820)); setInterval(() => {}, 1000);\n`,
    );
    await writeExecutable(
      decoderPath,
      `for await (const chunk of Bun.stdin.stream()) {}\n`,
    );
    let failedAt = 0;
    const { promise: failed, resolve: restarting } =
      Promise.withResolvers<void>();
    const clips: AudioClip[] = [];
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: rtlPath,
      multimonPath: decoderPath,
      audioTimeoutMs: 1500,
      clips: {
        enabled: true,
        continuous: true,
        directory: join(directory, "clips"),
        preSeconds: 0.2,
        postSeconds: 0.2,
        maxFiles: 10,
        maxBytes: 1_000_000,
      },
      onClip: (clip) => {
        clips.push(clip);
      },
      onState: (state) => {
        if (state.state === "restarting") {
          failedAt = Date.now();
          restarting();
        }
      },
    });
    try {
      await receiver.start();
      await failed;
      const lastAudioAt = receiver.status().lastAudioAt;
      await receiver.stop();
      expect(clips).toHaveLength(1);
      const clip = clips[0]!;
      const metadata = JSON.parse(await readFile(`${clip.path}.json`, "utf8"));
      expect(clip.reason).toBe("continuous");
      expect(wavPcm(await readFile(clip.path))).toHaveLength(8820);
      expect(clip.endedAt).toBe(lastAudioAt!);
      expect(metadata.endedAt).toBe(lastAudioAt);
      expect(failedAt - Date.parse(metadata.endedAt)).toBeGreaterThanOrEqual(
        1400,
      );
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "ongoing PCM refreshes the watchdog across several timeout periods",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-audio-watchdog-"));
    const rtlPath = join(directory, "receiver");
    const decoderPath = join(directory, "decoder");
    await writeExecutable(
      rtlPath,
      `setInterval(() => process.stdout.write(Buffer.alloc(2)), 20);\n`,
    );
    await writeExecutable(
      decoderPath,
      `for await (const chunk of Bun.stdin.stream()) {}\n`,
    );
    const receiver = new RadioReceiver({
      ...defaultOptions,
      rtlFmPath: rtlPath,
      multimonPath: decoderPath,
      audioTimeoutMs: 250,
    });
    try {
      await receiver.start();
      await delay(750);
      expect(receiver.status().state).toBe("running");
      expect(receiver.status().lastAudioAt).not.toBeNull();
      expect(receiver.status().restartCount).toBe(0);
      await receiver.stop();
      await delay(300);
      expect(receiver.status().state).toBe("stopped");
      expect(receiver.status().restartCount).toBe(0);
      const starting = receiver.start();
      await receiver.stop();
      await starting;
      expect(receiver.status().state).toBe("stopped");
      await delay(300);
      expect(receiver.status().restartCount).toBe(0);
      expect(receiver.status().state).toBe("stopped");
      await writeExecutable(rtlPath, `setInterval(() => {}, 1000);\n`);
      await receiver.start();
      expect(receiver.status().state).toBe("running");
      expect(receiver.status().lastAudioAt).toBeNull();
      await delay(100);
      expect(receiver.status().state).toBe("running");
    } finally {
      await receiver.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform !== "darwin" || !Bun.which("clang"))(
  "macOS native fwrite PCM reaches the decoder before libc buffering fills",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-native-stdio-"));
    const sourcePath = join(directory, "receiver.c");
    const rtlPath = join(directory, "receiver");
    const decoderPath = join(directory, "decoder");
    let receiver: RadioReceiver | undefined;
    try {
      await writeFile(
        sourcePath,
        `#include <stdio.h>\n#include <unistd.h>\nint main(void) {\n  unsigned char samples[1024] = {0};\n  for (;;) {\n    if (fwrite(samples, 1, sizeof samples, stdout) != sizeof samples) return 1;\n    usleep(20000);\n  }\n}\n`,
      );
      const compiler = Bun.spawn(
        [Bun.which("clang")!, sourcePath, "-o", rtlPath],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, output] = await Promise.all([
        compiler.exited,
        new Response(compiler.stderr).text(),
        new Response(compiler.stdout).text(),
      ]);
      if (exit !== 0)
        throw new Error(`Native fixture compilation failed: ${output}`);
      await writeExecutable(
        decoderPath,
        `for await (const chunk of Bun.stdin.stream()) {}\n`,
      );
      receiver = new RadioReceiver({
        ...defaultOptions,
        rtlFmPath: rtlPath,
        multimonPath: decoderPath,
        audioTimeoutMs: 1000,
      });
      await receiver.start();
      // At this production rate, a 512 KiB stdio buffer takes over ten seconds.
      await delay(500);
      expect(receiver.status().lastAudioAt).not.toBeNull();
      await delay(900);
      expect(receiver.status().state).toBe("running");
      expect(receiver.status().restartCount).toBe(0);
      expect(
        Date.now() - Date.parse(receiver.status().lastAudioAt!),
      ).toBeLessThan(500);
    } finally {
      await receiver?.stop();
      await rm(directory, { recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "replay timeout reaps an unresponsive decoder",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-replay-timeout-"));
    const decoderPath = join(directory, "decoder");
    const pidPath = join(directory, "decoder.pid");
    const wavPath = join(directory, "test.wav");
    await writeFile(wavPath, Buffer.concat([wavHeader(2), Buffer.alloc(2)]));
    await writeExecutable(
      decoderPath,
      `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    let pid: number | undefined;
    try {
      await expect(
        // Allow the interpreter to install its SIGTERM handler under host load.
        replayWav(wavPath, { multimonPath: decoderPath, timeoutMs: 1000 }),
      ).rejects.toThrow("timed out");
      pid = Number(await readFile(pidPath, "utf8"));
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true });
    }
  },
);
