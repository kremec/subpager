import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexClient, ConvexWorker } from "./convex";
import { Outbox } from "./outbox";
import type { Reception } from "./outbox";
import type { Page } from "./radio/decoder";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "subpager-outbox-"));
  directories.push(directory);
  return directory;
}
function page(offset = 0): Page {
  return {
    receivedAt: new Date(1_790_000_000_000 + offset).toISOString(),
    ric: 123,
    function: 3,
    type: "alpha",
    content: "ŠOLA<LF>GOLO<EOT><NUL>",
  };
}

test("complete atomic writes survive restart and are private, without normalizing content", () => {
  const directory = temporary();
  const outbox = new Outbox(directory);
  const reception = outbox.save(page());
  expect(reception.sourceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(readdirSync(directory)).toHaveLength(1);
  const pending = new Outbox(directory).pending();
  expect(pending[0]?.reception).toEqual(reception);
  expect(pending[0]?.reception.content).toBe(page().content);
  if (process.platform !== "win32")
    expect(statSync(join(directory, pending[0]!.name)).mode & 0o777).toBe(
      0o600,
    );
});

test("completed temporary writes recover while partial files are retained without blocking restart", () => {
  const directory = temporary();
  const outbox = new Outbox(directory);
  const reception = outbox.save(page());
  const original = outbox.pending()[0]!.name;
  renameSync(join(directory, original), join(directory, `${original}.tmp`));
  expect(new Outbox(directory).pending()[0]?.reception).toEqual(reception);
  writeFileSync(join(directory, "incomplete.json.tmp"), '{"sourceId":');
  writeFileSync(join(directory, "empty.json.tmp"), "");
  const committed = outbox.save(page(1));
  const restarted = new Outbox(directory);
  expect(readdirSync(directory)).toContain("incomplete.json.tmp.incomplete");
  expect(readdirSync(directory)).toContain("empty.json.tmp.incomplete");
  expect(restarted.pending().map((item) => item.reception.sourceId)).toEqual([
    reception.sourceId,
    committed.sourceId,
  ]);
});

test("outbox write failure is reported before a reception can be marked stored", () => {
  const directory = temporary();
  const path = join(directory, "outbox");
  const outbox = new Outbox(path);
  rmSync(path, { recursive: true });
  writeFileSync(path, "occupied");
  expect(() => outbox.save(page())).toThrow();
});

test("lost acknowledgements retry the persisted UUID after restart and only then delete files", async () => {
  const directory = temporary();
  let outbox = new Outbox(directory);
  const reception = outbox.save(page());
  const calls: Reception[][] = [];
  let lost = true;
  const client = new ConvexClient(
    "https://test.convex.site",
    "isolated-secret",
    async (_url, options) => {
      const body = JSON.parse(String(options.body)) as {
        messages: Reception[];
        notify: boolean;
      };
      calls.push(body.messages);
      expect(body.notify).toBe(true);
      if (lost)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("acknowledgement lost"));
            },
          }),
        );
      return Response.json({ inserted: 0 });
    },
  );
  let worker = new ConvexWorker(outbox, client);
  await worker.tick();
  expect(outbox.pending()).toHaveLength(1);
  expect(worker.lastError).toBe("acknowledgement lost");
  outbox = new Outbox(directory);
  worker = new ConvexWorker(outbox, client);
  lost = false;
  await worker.tick();
  expect(calls.map((messages) => messages[0]!.sourceId)).toEqual([
    reception.sourceId,
    reception.sourceId,
  ]);
  expect(outbox.pending()).toHaveLength(0);
  expect(worker.lastError).toBeNull();
});

test("singleflight upload preserves pages received while a batch is in flight", async () => {
  const outbox = new Outbox(temporary());
  outbox.save(page());
  const pending = Promise.withResolvers<Response>();
  let calls = 0;
  const client = new ConvexClient(
    "https://test.convex.site",
    "isolated-secret",
    async () => {
      calls++;
      return calls === 1 ? pending.promise : Response.json({ inserted: 1 });
    },
  );
  const worker = new ConvexWorker(outbox, client);
  const first = worker.tick();
  expect(worker.tick()).toBe(first);
  const later = outbox.save(page(1));
  expect(calls).toBe(1);
  expect(outbox.pending()).toHaveLength(2);
  pending.resolve(Response.json({ inserted: 1 }));
  await first;
  expect(outbox.pending().map((item) => item.reception.sourceId)).toEqual([
    later.sourceId,
  ]);
  await worker.tick();
  expect(calls).toBe(2);
  expect(outbox.pending()).toHaveLength(0);
});

test("upload batches preserve reception order and retries back off without deleting pending data", async () => {
  const outbox = new Outbox(temporary());
  for (let index = 119; index >= 0; index--) outbox.save(page(index));
  let fail = true;
  const calls: Reception[][] = [];
  const client = new ConvexClient(
    "https://test.convex.site",
    "isolated-secret",
    async (_url, options) => {
      calls.push(
        (JSON.parse(String(options.body)) as { messages: Reception[] })
          .messages,
      );
      return fail
        ? new Response(null, { status: 503 })
        : Response.json({ inserted: 1 });
    },
  );
  const worker = new ConvexWorker(outbox, client);
  await worker.tick(0);
  await worker.tick(1000);
  expect(calls).toHaveLength(1);
  expect(outbox.pending()).toHaveLength(100);
  fail = false;
  await worker.tick(16_000);
  expect(calls[1]).toHaveLength(100);
  expect(calls[1]![0]!.receivedAt).toBe(page(0).receivedAt);
  expect(calls[1]!.at(-1)!.receivedAt).toBe(page(99).receivedAt);
  expect(calls[1]).toEqual(calls[0]!);
  await worker.tick(20_000);
  expect(calls[2]).toHaveLength(20);
  expect(outbox.pending()).toHaveLength(0);
});
