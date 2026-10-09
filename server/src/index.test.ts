import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, initConfig, loadConfig } from "./config";
import { wavPcm } from "./radio/audio";

test.skipIf(process.platform === "win32").each([false, true])(
  "receiver awaits an in-flight outbox upload on shutdown with recording enabled=%s",
  async (enabled) => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-receiver-"));
    const config = join(directory, "config.json");
    const clips = join(directory, "clips");
    const outbox = join(directory, "outbox");
    const preload = join(directory, "transport.ts");
    const rtl = join(directory, "receiver");
    const decoder = join(directory, "decoder");
    const rtlPid = join(directory, "receiver.pid");
    const decoderPid = join(directory, "decoder.pid");
    const sending = join(directory, "sending");
    const acknowledgement = join(directory, "acknowledged");
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    const output: Promise<string>[] = [];
    try {
      await Bun.write(
        config,
        JSON.stringify({
          ...defaultConfig,
          outbox,
          firebase: defaultConfig.firebase,
          radio: {
            ...defaultConfig.radio,
            rtlFmPath: rtl,
            multimonPath: decoder,
          },
          clips: {
            ...defaultConfig.clips,
            enabled,
            directory: clips,
            preSeconds: 1,
            postSeconds: 1,
          },
        }),
      );
      // The SDK backend and jobs processor are isolated from all cloud access.
      await Bun.write(
        preload,
        `import { mock } from 'bun:test';
        import { Firestore } from ${JSON.stringify(import.meta.resolve("firebase-admin/firestore"))};
        import { FirebaseBackend } from ${JSON.stringify(join(import.meta.dir, "firebase.ts"))};
        const db = new Firestore({projectId:"subpager-test"});
        const backend = new FirebaseBackend(db);
        backend.users.ready = async () => {};
        backend.users.stop = () => {};
        backend.ingest = async (messages) => {
          await Bun.write(${JSON.stringify(sending)}, JSON.stringify({messages}));
          await Bun.sleep(2500);
          await Bun.write(${JSON.stringify(acknowledgement)}, "ok");
        };
        FirebaseBackend.open = async () => backend;
        mock.module(${JSON.stringify(join(import.meta.dir, "processor.ts"))}, () => ({
          FirestoreJobsProcessor: class { start() {} async stop() {} }
        }));`,
      );
      await Bun.write(
        rtl,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(rtlPid)}, String(process.pid)); setInterval(() => process.stdout.write(Buffer.alloc(8820,42)),20);\n`,
      );
      const call = {
        demod_name: "POCSAG1200",
        address: 123456,
        function: 3,
        alpha: "TEST ČŠŽ<EOT><NUL>",
      };
      await Bun.write(
        decoder,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(decoderPid)}, String(process.pid)); let sent=false; for await(const chunk of Bun.stdin.stream()) { if(!sent && chunk.length) {sent=true; console.log(${JSON.stringify(JSON.stringify(call))});} }\n`,
      );
      await Promise.all([chmod(rtl, 0o700), chmod(decoder, 0o700)]);
      child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          join(import.meta.dir, "index.ts"),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            SUBPAGER_CONFIG: config,
            SUBPAGER_NO_RADIO: "0",
          },
        },
      );
      output.push(
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      );
      for (
        let attempt = 0;
        attempt < 40 && !(await Bun.file(sending).exists());
        attempt++
      )
        await Bun.sleep(50);
      expect(await Bun.file(sending).exists()).toBe(true);
      const payload = JSON.parse(await Bun.file(sending).text());
      expect(payload.messages[0].content).toBe(call.alpha);
      expect(payload.messages[0].sourceId).toMatch(/^[A-Za-z0-9]{20}$/);
      expect(payload.messages[0].id).toBeUndefined();
      expect(
        (await readdir(outbox)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(1);
      await Bun.sleep(1200);
      child.kill();
      expect(await child.exited).toBe(0);
      expect(await Bun.file(acknowledgement).exists()).toBe(true);
      expect(await readdir(outbox)).toHaveLength(0);
      if (enabled) {
        const files = await readdir(clips);
        const wavName = files.find((name) => name.endsWith(".wav"))!;
        expect(wavName).toBeDefined();
        const pcm = wavPcm(
          Buffer.from(await Bun.file(join(clips, wavName)).bytes()),
        );
        expect(pcm.length).toBeGreaterThanOrEqual(44100);
        expect(pcm).toEqual(Buffer.alloc(pcm.length, 42));
        const metadata = await Bun.file(join(clips, `${wavName}.json`)).json();
        expect(metadata.calls[0].content).toBe(call.alpha);
      } else {
        expect(await readdir(directory)).not.toContain("clips");
      }
      for (const file of [rtlPid, decoderPid]) {
        const pid = Number(await Bun.file(file).text());
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await Promise.all(output);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);

test("package replay preserves raw content without creating an outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager readonly replay-"));
  try {
    const outbox = join(directory, "outbox");
    const config = join(directory, "config.json");
    const input = join(directory, "pages.jsonl");
    await Bun.write(config, JSON.stringify({ ...defaultConfig, outbox }));
    await Bun.write(
      input,
      JSON.stringify({
        demod_name: "POCSAG1200",
        address: 123456,
        function: 3,
        alpha: "TEST ČŠŽ<EOT><NUL>",
      }),
    );
    const replay = Bun.spawn([process.execPath, "run", "replay", input], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SUBPAGER_CONFIG: config },
    });
    const output = await new Response(replay.stdout).text();
    await new Response(replay.stderr).text();
    expect(await replay.exited).toBe(0);
    expect(JSON.parse(output.split("\n")[0]!).content).toBe(
      "TEST ČŠŽ<EOT><NUL>",
    );
    expect(await Bun.file(outbox).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config creation is exclusive and private, with a config-independent decoder path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-config-"));
  const file = join(directory, "nested", "config.json");
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => initConfig(file)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(7);
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    const config = await loadConfig(file);
    expect(config.radio.multimonPath).toBe(defaultConfig.radio.multimonPath);
    expect(config.outbox).toBe(join(directory, "nested", "data", "outbox"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "doctor drains decoder help and USB output concurrently",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-doctor-"));
    try {
      const rtl = join(directory, "rtl_fm");
      const usb = join(directory, "rtl_sdr");
      const decoder = join(directory, "decoder");
      const config = join(directory, "config.json");
      await Bun.write(rtl, "unused");
      await Bun.write(
        usb,
        `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(8192));\n`,
      );
      await Bun.write(
        decoder,
        `#!${process.execPath}\nprocess.stderr.write('x'.repeat(200000) + '--json');\n`,
      );
      await Promise.all([chmod(usb, 0o700), chmod(decoder, 0o700)]);
      await Bun.write(
        config,
        JSON.stringify({
          ...defaultConfig,
          radio: {
            ...defaultConfig.radio,
            rtlFmPath: rtl,
            multimonPath: decoder,
          },
        }),
      );
      const child = Bun.spawn([process.execPath, "run", "doctor"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SUBPAGER_CONFIG: config },
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit).toBe(0);
        expect(stderr).not.toContain("Decoder does not advertise");
        expect(stdout).toContain("USB sample check: passed");
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([
  ["decoder", "SIGTERM"],
  ["USB", "SIGINT"],
] as const)(
  "interrupting doctor during %s reaps its child",
  async (phase, signal) => {
    const directory = await mkdtemp(join(tmpdir(), "subpager-doctor-cancel-"));
    const rtl = join(directory, "rtl_fm");
    const usb = join(directory, "rtl_sdr");
    const decoder = join(directory, "decoder");
    const pidFile = join(directory, "child.pid");
    const config = join(directory, "config.json");
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let pid: number | undefined;
    try {
      const hang = `#!${process.execPath}\nawait Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`;
      await Bun.write(rtl, "unused");
      await Bun.write(
        decoder,
        phase === "decoder"
          ? hang
          : `#!${process.execPath}\nconsole.log('--json');\n`,
      );
      await Bun.write(usb, hang);
      await Promise.all([chmod(usb, 0o700), chmod(decoder, 0o700)]);
      await Bun.write(
        config,
        JSON.stringify({
          ...defaultConfig,
          radio: {
            ...defaultConfig.radio,
            rtlFmPath: rtl,
            multimonPath: decoder,
          },
        }),
      );
      child = Bun.spawn([process.execPath, "run", "doctor"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SUBPAGER_CONFIG: config },
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      for (let i = 0; i < 100 && !(await Bun.file(pidFile).exists()); i++)
        await Bun.sleep(20);
      pid = Number(await Bun.file(pidFile).text());
      child.kill(signal);
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 2000);
      try {
        expect(await child.exited).toBe(130);
        expect(await stderr).not.toContain("Decoder does not advertise");
        expect(await stdout).not.toContain("USB sample check: passed");
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
