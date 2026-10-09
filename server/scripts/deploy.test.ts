import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

async function deploy(failure?: "archive" | "install") {
  const dir = await mkdtemp(join(tmpdir(), "subpager-deploy-test-"));
  temporary.push(dir);
  const home = join(dir, "home");
  const target = join(home, "subpager");
  const bin = join(dir, "bin");
  const events = join(dir, "events");
  const kept = [
    "server/.env",
    "server/config.json",
    "server/receiver-service-account.json",
    "server/data/outbox/pending.json",
    "server/data/clips/recording.wav",
    "server/bin/multimon-ng",
  ];
  await mkdir(bin, { recursive: true });
  await writeFile(events, "");
  await mkdir(join(target, "app"), { recursive: true });
  for (const file of [
    ...kept,
    "server/src/obsolete.ts",
    "server/scripts/obsolete.sh",
    "server/node_modules/old-dependency",
    "node_modules/old-dependency",
  ]) {
    const path = join(target, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "keep this");
  }
  const commands = {
    ssh: `echo ssh >> "$DEPLOY_TEST_EVENTS"\nfor command do :; done\nexec /bin/sh -c "$command"`,
    bun: `echo install >> "$DEPLOY_TEST_EVENTS"
${failure === "install" ? "exit 23" : "mkdir -p node_modules; echo installed > node_modules/runtime"}`,
    doas: `printf '%s\\n' "$*" >> "$DEPLOY_TEST_EVENTS"`,
  };
  for (const [name, script] of Object.entries(commands)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  if (failure === "archive") {
    await writeFile(
      join(bin, "tar"),
      '#!/bin/sh\n/usr/bin/tar "$@"\nexit 23\n',
      {
        mode: 0o755,
      },
    );
  }
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "deploy.ts")],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        DEPLOY_TEST_EVENTS: events,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    home,
    target,
    kept,
    code,
    output,
    error,
    events: await Bun.file(events).text(),
  };
}

test("deploy replaces code and dependencies while preserving box state", async () => {
  const result = await deploy();
  expect(result.error).toBe("");
  expect(result.code).toBe(0);
  expect(result.events.trim().split("\n")).toEqual([
    "ssh",
    "install",
    "rc-service subpager stop",
    "rc-service subpager start",
    "rc-service subpager status",
  ]);
  for (const file of result.kept) {
    expect(await Bun.file(join(result.target, file)).text()).toBe("keep this");
  }
  expect(
    await Bun.file(join(result.target, "server/src/index.ts")).text(),
  ).toBe(await Bun.file(join(import.meta.dir, "../src/index.ts")).text());
  expect(
    await Bun.file(join(result.target, "node_modules/runtime")).text(),
  ).toBe("installed\n");
  for (const file of [
    "server/src/obsolete.ts",
    "server/scripts/obsolete.sh",
    "server/node_modules/old-dependency",
    "node_modules/old-dependency",
    "server/src/index.test.ts",
  ]) {
    expect(await Bun.file(join(result.target, file)).exists()).toBe(false);
  }
  expect(await readdir(result.home)).toEqual(["subpager"]);
});

test("failed dependency installation leaves the running installation unchanged", async () => {
  const result = await deploy("install");
  expect(result.code).not.toBe(0);
  expect(result.events).toBe("ssh\ninstall\n");
  for (const file of [
    ...result.kept,
    "server/src/obsolete.ts",
    "node_modules/old-dependency",
  ]) {
    expect(await Bun.file(join(result.target, file)).text()).toBe("keep this");
  }
  expect(await readdir(result.home)).toEqual(["subpager"]);
});

test("failed local archiving does not upload a partial release", async () => {
  const result = await deploy("archive");
  expect(result.code).not.toBe(0);
  expect(result.events).toBe("");
  expect(
    await Bun.file(join(result.target, "server/src/obsolete.ts")).text(),
  ).toBe("keep this");
  expect(await readdir(result.home)).toEqual(["subpager"]);
});
