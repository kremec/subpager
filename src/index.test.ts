import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, initConfig, loadConfig } from "./config";
import { wavPcm } from "./radio/audio";
import { Store } from "./store";

test.skipIf(process.platform === "win32")(
  "Server archives recordings before staging cleanup and awaits push delivery on shutdown",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "subpager-message-archive-"),
    );
    const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = probe.port;
    await probe.stop(true);
    const config = join(directory, "config.json");
    const clips = join(directory, "clips");
    const preload = join(directory, "transport.ts");
    const rtl = join(directory, "receiver");
    const decoder = join(directory, "decoder");
    const rtlPid = join(directory, "receiver.pid");
    const decoderPid = join(directory, "decoder.pid");
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let store: Store | undefined;
    const output: Promise<string>[] = [];
    const start = (noRadio = false) => {
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
            SUBPAGER_NO_RADIO: noRadio ? "1" : "0",
          },
        },
      );
      output.push(
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      );
      return child;
    };
    try {
      await Bun.write(
        config,
        JSON.stringify({
          ...defaultConfig,
          database: "./history.sqlite",
          api: { host: "127.0.0.1", port },
          radio: {
            ...defaultConfig.radio,
            rtlFmPath: rtl,
            multimonPath: decoder,
          },
          clips: {
            ...defaultConfig.clips,
            directory: clips,
            preSeconds: 1,
            postSeconds: 1,
            continuous: false,
          },
        }),
      );
      // Every outbound request is intercepted inside the subprocess.
      await Bun.write(
        preload,
        `globalThis.fetch = async () => { throw new Error("Unexpected outbound request"); };`,
      );
      start();
      const timeout = setTimeout(() => child?.kill(), 5000);
      try {
        expect(await child!.exited).toBe(1);
      } finally {
        clearTimeout(timeout);
      }
      store = new Store(join(directory, "history.sqlite"));
      expect(store.list({ limit: 10 }).messages).toHaveLength(0);

      const call = {
        demod_name: "POCSAG1200",
        address: 123456,
        function: 3,
        alpha: "TEST ČŠŽ",
      };
      await Bun.write(
        rtl,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(rtlPid)}, String(process.pid)); setInterval(() => process.stdout.write(Buffer.alloc(8820, 42)), 20);\n`,
      );
      await Bun.write(
        decoder,
        `#!${process.execPath}\nawait Bun.write(${JSON.stringify(decoderPid)}, String(process.pid)); let sent=false; for await (const chunk of Bun.stdin.stream()) { if(!sent && chunk.length) { sent=true;console.log(${JSON.stringify(JSON.stringify(call))}); } }\n`,
      );
      await Promise.all([chmod(rtl, 0o700), chmod(decoder, 0o700)]);
      start();
      let archived = false;
      for (let i = 0; i < 60; i++) {
        const message = store.list({ limit: 10 }).messages[0];
        if (
          message &&
          store.getRecording(message.id) &&
          (await readdir(clips)).length === 0
        ) {
          archived = true;
          break;
        }
        await Bun.sleep(100);
      }
      expect(archived).toBe(true);
      child!.kill();
      expect(await child!.exited).toBe(0);
      const messages = store.list({ limit: 10 }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe(call.alpha);
      const recording = store.getRecording(messages[0]!.id)!;
      const pcm = wavPcm(Buffer.from(recording.wav));
      expect(pcm.length).toBeGreaterThanOrEqual(44100);
      expect(pcm).toEqual(Buffer.alloc(pcm.length, 42));
      expect(await readdir(clips)).toEqual([]);
      // Retry staging left behind after a successful DB commit but before unlink.
      const retryPath = join(clips, "subpager-decoded-retry.wav");
      await Bun.write(retryPath, recording.wav);
      await Bun.write(
        `${retryPath}.json`,
        JSON.stringify({
          path: join(directory, "stale-recording-location.wav"),
          calls: [
            {
              ric: call.address,
              function: call.function,
              type: "alpha",
              content: call.alpha,
              receivedAt: messages[0]!.receivedAt,
            },
          ],
        }),
      );
      start(true);
      let retried = false;
      for (let i = 0; i < 40; i++) {
        if ((await readdir(clips)).length === 0) {
          retried = true;
          break;
        }
        await Bun.sleep(100);
      }
      expect(retried).toBe(true);
      child!.kill();
      expect(await child!.exited).toBe(0);
      expect(store.getRecording(messages[0]!.id)).toEqual(recording);
      expect(
        store.db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM messages WHERE wav IS NOT NULL",
          )
          .get()!.count,
      ).toBe(1);
      // Shutdown must await a ticket already in flight, even after another tick.
      const device = store.addDevice("shutdown test");
      store.registerDevice(device.id, "ExpoPushToken[shutdown]");
      const pushMessage = store.save(
        {
          ...messages[0]!,
          receivedAt: new Date().toISOString(),
          content: "shutdown",
        },
        30,
        300,
      );
      const sending = join(directory, "sending");
      await Bun.write(
        preload,
        `globalThis.fetch = async () => {
          await Bun.write(${JSON.stringify(sending)}, "started");
          await Bun.sleep(2500);
          return Response.json({ data: [{ status: "ok", id: "shutdown-ticket" }] });
        };`,
      );
      start(true);
      for (let i = 0; i < 40 && !(await Bun.file(sending).exists()); i++)
        await Bun.sleep(100);
      expect(await Bun.file(sending).exists()).toBe(true);
      await Bun.sleep(1200);
      child!.kill();
      expect(await child!.exited).toBe(0);
      expect(
        store.db
          .query("SELECT state, ticket_id FROM push_jobs WHERE message_id = ?")
          .get(pushMessage.id),
      ).toEqual({ state: "receipt", ticket_id: "shutdown-ticket" });
      store.disablePush(device.id);
      // A failed live insert must stop the API and both native processes.
      store.db.exec(`CREATE TRIGGER fail_call BEFORE INSERT ON messages
        BEGIN SELECT RAISE(ABORT, 'simulated message storage failure'); END;`);
      start();
      const shutdownTimeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
      try {
        expect(await child!.exited).toBe(1);
      } finally {
        clearTimeout(shutdownTimeout);
      }
      for (const file of [rtlPid, decoderPid]) {
        const pid = Number(await Bun.file(file).text());
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(store.list({ limit: 10 }).messages).toHaveLength(2);
      const logs = (await Promise.all(output)).join("\n");
      expect(logs).toContain(
        "Message storage failed: simulated message storage failure",
      );
      expect(logs).toMatch(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO Received call 1; receivedAt=.*; RIC=0123456; function=3; type=alpha; content="TEST ČŠŽ"/,
      );
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

test("package replay normalizes content without opening history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager readonly replay-"));
  try {
    const database = join(directory, "history.sqlite");
    const config = join(directory, "config.json");
    const input = join(directory, "pages.jsonl");
    await Bun.write(config, JSON.stringify({ ...defaultConfig, database }));
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
    expect(JSON.parse(output.split("\n")[0]!).content).toBe("TEST ČŠŽ");
    expect(await Bun.file(database).exists()).toBe(false);
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
    expect(config.database).toBe(
      join(directory, "nested", "data", "subpager.sqlite"),
    );
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
