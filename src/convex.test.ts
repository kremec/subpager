import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexClient, ConvexWorker } from "./convex";
import { Store } from "./store";
import type { Page } from "./radio/decoder";

const page: Page = {
  receivedAt: new Date().toISOString(),
  ric: 123,
  function: 3,
  type: "alpha",
  content: "ŠOLA GOLO",
};

test("cloud cursor survives restart, stays on failed batch, and is separate per deployment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-convex-"));
  const path = join(directory, "history.sqlite");
  let store = new Store(path, true);
  const calls: { messages: { id: number }[]; notify: boolean }[] = [];
  let fail = true;
  const transport: (
    url: string,
    options: RequestInit,
  ) => Promise<Response> = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return fail
      ? new Response(null, { status: 503 })
      : Response.json({ inserted: 1 });
  };
  const client = new ConvexClient(
    "https://first.convex.site",
    "secret",
    transport,
  );
  try {
    const device = store.addDevice("old local phone");
    store.registerDevice(device.id, "ExpoPushToken[test]");
    const first = store.save(page, 30, 300);
    expect(store.pendingCount()).toBe(0);
    let worker = new ConvexWorker(store, client);
    await worker.tick(0, false);
    expect(worker.cursor).toBe(0);
    fail = false;
    await worker.tick(15_100, false);
    expect(worker.cursor).toBe(first.id);
    expect(calls.map((call) => call.notify)).toEqual([false, false]);
    store.close();
    store = new Store(path, true);
    worker = new ConvexWorker(store, client);
    expect(worker.cursor).toBe(first.id);
    await worker.tick(20_000);
    expect(calls).toHaveLength(2);
    const other = new ConvexWorker(
      store,
      new ConvexClient("https://second.convex.site", "secret", transport),
    );
    expect(other.cursor).toBe(0);
    await other.tick(20_000, false);
    expect(other.cursor).toBe(first.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud upload never waits for extraction and includes completed locations on another deployment", async () => {
  const store = new Store(":memory:", true, true);
  const bodies: { messages: { location?: string }[] }[] = [];
  const transport: (
    url: string,
    options: RequestInit,
  ) => Promise<Response> = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({ inserted: 1 });
  };
  try {
    const message = store.save(page, 30, 300);
    const worker = new ConvexWorker(
      store,
      new ConvexClient("https://first.convex.site", "secret", transport),
    );
    await worker.tick();
    expect(worker.cursor).toBe(message.id);
    expect(bodies[0]?.messages[0]?.location).toBeUndefined();
    store.db
      .query(
        "UPDATE location_jobs SET state = 'uploaded', location = ? WHERE message_id = ?",
      )
      .run("ŠOLA GOLO", message.id);
    await new ConvexWorker(
      store,
      new ConvexClient("https://second.convex.site", "secret", transport),
    ).tick();
    expect(bodies[1]?.messages[0]?.location).toBe("ŠOLA GOLO");
  } finally {
    store.close();
  }
});
