import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "./store";
import { createHandler } from "./api";
import { PushWorker } from "./delivery";
import { defaultConfig, validateConfig } from "./config";
import type { Page } from "./radio/decoder";

const stores: Store[] = [];
const directories: string[] = [];
function memory() {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}
function handlerFor(store: Store) {
  return createHandler({
    store,
    receiverStatus: () => ({
      state: "disabled",
      error: null,
      lastMessageAt: null,
    }),
    pushError: () => null,
  });
}
function subscribed(token = "ExpoPushToken[test]") {
  const store = memory();
  const device = store.addDevice("test");
  store.registerDevice(device.id, token);
  return { store, device };
}
function page(overrides: Partial<Page> = {}): Page {
  return {
    receivedAt: new Date().toISOString(),
    ric: 123456,
    function: 3,
    type: "alpha",
    content: "TEST ČŠŽ",
    ...overrides,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("RIC unit table keeps numeric unique addresses and nonempty names", () => {
  const store = memory();
  const insert = store.db.query(
    "INSERT INTO ric_units (ric, unit_name) VALUES (?, ?)",
  );
  insert.run(0, "First unit");
  insert.run(2097151, "Last unit");
  expect(store.ricUnits()).toEqual([
    { ric: 0, unitName: "First unit" },
    { ric: 2097151, unitName: "Last unit" },
  ]);
  for (const ric of [-1, 2097152, 1.5])
    expect(() => insert.run(ric, "Invalid")).toThrow();
  expect(() => insert.run(0, "Duplicate")).toThrow();
  expect(() => insert.run(42, "   ")).toThrow();
  store.db
    .query("UPDATE ric_units SET unit_name = ? WHERE ric = ?")
    .run("Renamed", 0);
  expect(store.ricUnits()[0]?.unitName).toBe("Renamed");
});

test("keeps every reception but queues one alert per exact repeated call and RIC", () => {
  const { store } = subscribed();
  const first = store.save(page(), 30, 300);
  const repeated = store.save(page(), 30, 300);
  const differentRic = store.save(page({ ric: 654321 }), 30, 300);
  expect(repeated.duplicateOf).toBe(first.id);
  expect(differentRic.duplicateOf).toBeNull();
  expect(store.list({ limit: 10 }).messages).toHaveLength(2);
  expect(store.list({ limit: 10, includeRepeats: true }).messages).toHaveLength(
    3,
  );
  expect(store.pendingCount()).toBe(2);
});

test("same message outside the fixed dedupe window is a new call", () => {
  const store = memory();
  const now = Date.now();
  const first = store.save(
    page({ receivedAt: new Date(now).toISOString() }),
    30,
    300,
  );
  store.save(
    page({ receivedAt: new Date(now + 20000).toISOString() }),
    30,
    300,
  );
  const later = store.save(
    page({ receivedAt: new Date(now + 31000).toISOString() }),
    30,
    300,
  );
  expect(first.duplicateOf).toBeNull();
  expect(later.duplicateOf).toBeNull();
});

test("token-only registration preserves pending jobs and obsolete filters do not restrict alerts", async () => {
  const { store, device } = subscribed("ExpoPushToken[test]");
  store.save(page(), 30, 300);
  const handler = handlerFor(store);
  for (const body of [
    { expoPushToken: "ExpoPushToken[test]" },
    { expoPushToken: "ExpoPushToken[test]", rics: [123456] },
  ]) {
    const result = await handler(
      new Request("https://test/v1/devices/me", {
        method: "PUT",
        headers: { authorization: `Bearer ${device.token}` },
        body: JSON.stringify(body),
      }),
    );
    expect(result.status).toBe(200);
    expect(store.pendingCount()).toBe(1);
  }
  store.save(page({ ric: 654321 }), 30, 300);
  expect(store.pendingCount()).toBe(2);
});

test("late delivery writes cannot mutate a newer job with a reused ID", () => {
  const { store, device } = subscribed("ExpoPushToken[old]");
  store.save(page(), 0, 300);
  const old = store.dueJobs("pending", Date.now())[0]!;
  store.registerDevice(device.id, "ExpoPushToken[new]");
  store.save(page({ content: "new call" }), 0, 300);
  const replacement = store.dueJobs("pending", Date.now())[0]!;
  expect(replacement.id).toBe(old.id);
  expect(replacement.messageId).not.toBe(old.messageId);
  const before = store.db.query("SELECT * FROM push_jobs").get();
  store.setJob(
    old,
    "receipt",
    Date.now(),
    null,
    "old-ticket",
    old.expoPushToken,
  );
  expect(store.db.query("SELECT * FROM push_jobs").get()).toEqual(before);
  store.setJob(
    replacement,
    "receipt",
    Date.now(),
    null,
    "new-ticket",
    replacement.expoPushToken,
  );
  expect(store.db.query("SELECT ticket_id FROM push_jobs").get()).toEqual({
    ticket_id: "new-ticket",
  });
});

test("cursor pagination retains equal-timestamp calls and revoked keys stop working", async () => {
  const store = memory();
  const device = store.addDevice("test");
  const receivedAt = new Date().toISOString();
  for (const content of ["one", "two", "three"])
    store.save(page({ receivedAt, content }), 30, 300);
  const first = store.list({ limit: 2 });
  const second = store.list({ limit: 2, before: first.nextCursor! });
  expect(
    [...first.messages, ...second.messages].map((message) => message.content),
  ).toEqual(["three", "two", "one"]);
  const handler = handlerFor(store);
  const request = () =>
    new Request("https://test/v1/messages", {
      headers: { authorization: `Bearer ${device.token}` },
    });
  expect((await handler(request())).status).toBe(200);
  store.revokeDevice(device.id);
  expect((await handler(request())).status).toBe(401);
});

test("API rejects malformed pagination and token bodies without mutating device state", async () => {
  const store = memory();
  const device = store.addDevice("test");
  const handler = handlerFor(store);
  const headers = { authorization: `Bearer ${device.token}` };
  for (const query of ["limit=101", "before=nan", "ric=2097152", "ric=1.5"]) {
    expect(
      (
        await handler(
          new Request(`https://test/v1/messages?${query}`, { headers }),
        )
      ).status,
    ).toBe(400);
  }
  for (const body of ["null", "{", '{"expoPushToken":"bad","rics":[]}']) {
    expect(
      (
        await handler(
          new Request("https://test/v1/devices/me", {
            method: "PUT",
            headers,
            body,
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect(store.authenticate(device.token)?.expoPushToken).toBeNull();
});

test("authentication storage failures return a JSON 500 response", async () => {
  const store = memory();
  const device = store.addDevice("test");
  const handler = handlerFor(store);
  store.close();
  const response = await handler(
    new Request("https://test/v1/messages", {
      headers: { authorization: `Bearer ${device.token}` },
    }),
  );
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "Server operation failed" });
});

test("network failure leaves jobs durable across database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subpager-store-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  let store = new Store(path);
  const device = store.addDevice("test");
  store.registerDevice(device.id, "ExpoPushToken[test]");
  store.save(page(), 30, 300);
  const worker = new PushWorker(store, async () => {
    throw new Error("offline");
  });
  await worker.tick();
  expect(worker.lastError).toBe("offline");
  store.close();
  store = new Store(path);
  stores.push(store);
  expect(store.pendingCount()).toBe(1);
  expect(store.dueJobs("pending", Date.now() + 5000)[0]?.attempts).toBe(1);
});

test.each(["send", "authorization", "receipt"])(
  "%s retry backoff starts after the failed operation completes",
  async (stage) => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { store } = subscribed();
      store.save(page({ receivedAt: new Date(now).toISOString() }), 0, 300);
      let failures = 0;
      const fail = () => {
        failures++;
        now += 10000;
        throw new Error("operation timed out");
      };
      const worker = new PushWorker(
        store,
        async (url) => {
          if (stage === "send" || url.endsWith("getReceipts")) fail();
          return Response.json({ data: [{ status: "ok", id: "ticket" }] });
        },
        undefined,
        stage === "authorization" ? async () => fail() : undefined,
      );
      if (stage === "receipt") {
        await worker.tick(now);
        now += 15 * 60000;
      }
      await worker.tick(now);
      const delay = stage === "receipt" ? 2000 : 1000;
      expect(
        store.db.query("SELECT next_attempt FROM push_jobs").get(),
      ).toEqual({ next_attempt: now + delay });
      const failedAt = now;
      now = failedAt + delay - 1;
      await worker.tick(now);
      expect(failures).toBe(1);
      now++;
      await worker.tick(now);
      expect(failures).toBe(2);
    } finally {
      clock.mockRestore();
    }
  },
);

test("concurrent push ticks share delivery and retain work queued during a request", async () => {
  const { store } = subscribed();
  const firstMessage = store.save(page(), 0, 300);
  const { promise: response, resolve } = Promise.withResolvers<Response>();
  const sent: number[][] = [];
  const worker = new PushWorker(store, async (_url, options) => {
    const messages = JSON.parse(options.body as string) as {
      data: { messageId: number };
    }[];
    sent.push(messages.map((message) => message.data.messageId));
    return response;
  });
  const now = Date.now();
  const first = worker.tick(now);
  const second = worker.tick(now);
  expect(second).toBe(first);
  const nextMessage = store.save(page({ content: "next call" }), 0, 300);
  expect(sent).toEqual([[firstMessage.id]]);
  resolve(Response.json({ data: [{ status: "ok", id: "ticket" }] }));
  await Promise.all([first, second]);
  expect(store.pendingCount()).toBe(1);
  await worker.tick(now + 1000);
  expect(sent).toEqual([[firstMessage.id], [nextMessage.id]]);
});

test("provider tickets wait for receipts without resending accepted alerts", async () => {
  const { store } = subscribed();
  store.save(page(), 30, 300);
  const requests: string[] = [];
  const worker = new PushWorker(store, async (url, options) => {
    requests.push(url);
    if (url.endsWith("send")) {
      const payload = JSON.parse(options.body as string);
      expect(payload[0].title).toStartWith("0123456 · ");
      expect(payload[0].body).toBe("TEST ČŠŽ");
      expect(payload[0].data.messageId).toBe(1);
      expect(payload[0].channelId).toBe("pager-alerts");
      expect(payload[0].priority).toBe("high");
      return Response.json({ data: [{ status: "ok", id: "ticket-1" }] });
    }
    return Response.json({ data: { "ticket-1": { status: "ok" } } });
  });
  const now = Date.now();
  await worker.tick(now);
  await worker.tick(now + 1000);
  expect(requests).toHaveLength(1);
  await worker.tick(now + 15 * 60000 + 1);
  expect(requests).toHaveLength(2);
  expect(store.pendingCount()).toBe(0);
  expect(
    store.db.query<{ state: string }, []>("SELECT state FROM push_jobs").get()
      ?.state,
  ).toBe("sent");
});

test("notifications preserve received content, including long messages and empty tone alerts", async () => {
  const { store } = subscribed();
  const content = "Received ČŠŽ ".repeat(60);
  store.save(page({ content }), 0, 300);
  store.save(page({ ric: 654321, type: "tone", content: "" }), 0, 300);
  const worker = new PushWorker(store, async (_url, options) => {
    const payload = JSON.parse(options.body as string) as {
      title: string;
      body: string;
    }[];
    expect(
      payload.map((message) => ({
        ric: message.title.split(" · ")[0],
        body: message.body,
      })),
    ).toEqual([
      { ric: "0123456", body: content },
      { ric: "0654321", body: "" },
    ]);
    return Response.json({
      data: payload.map((_message, index) => ({
        status: "ok",
        id: `ticket-${index}`,
      })),
    });
  });
  await worker.tick();
});

test.each([
  {
    receivedAt: "2026-10-08T10:07:00.000Z",
    title: "0123456 · 08/10/2026, 12:07",
  },
  {
    receivedAt: "2026-01-08T23:07:00.000Z",
    title: "0123456 · 09/01/2026, 00:07",
  },
])(
  "notification title uses Ljubljana reception time: $receivedAt",
  async (fixture) => {
    const { store } = subscribed();
    const now = Date.parse(fixture.receivedAt);
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      store.save(page({ receivedAt: fixture.receivedAt }), 0, 300);
    } finally {
      clock.mockRestore();
    }
    let payload: { title: string; body: string }[] = [];
    const worker = new PushWorker(store, async (_url, options) => {
      payload = JSON.parse(options.body as string);
      return Response.json({ data: [{ status: "ok", id: "ticket" }] });
    });
    await worker.tick(now + 60000);
    expect(
      payload.map((message) => ({ title: message.title, body: message.body })),
    ).toEqual([{ title: fixture.title, body: "TEST ČŠŽ" }]);
  },
);

test("a later ticket write failure does not requeue an accepted alert", async () => {
  const { store } = subscribed();
  const first = store.save(page({ content: "first" }), 30, 300);
  const second = store.save(page({ content: "second" }), 30, 300);
  store.db.exec(`CREATE TRIGGER fail_ticket BEFORE UPDATE OF state ON push_jobs
    WHEN NEW.message_id = ${second.id} AND NEW.state = 'receipt'
    BEGIN SELECT RAISE(ABORT, 'simulated ticket write failure'); END;`);
  const sent: number[][] = [];
  const worker = new PushWorker(store, async (_url, options) => {
    const messages = JSON.parse(options.body as string) as {
      data: { messageId: number };
    }[];
    sent.push(messages.map((message) => message.data.messageId));
    return Response.json({
      data: messages.map((message) => ({
        status: "ok",
        id: `ticket-${message.data.messageId}`,
      })),
    });
  });
  const now = Date.now();
  await expect(worker.tick(now)).rejects.toThrow(
    "simulated ticket write failure",
  );
  expect(
    store.db
      .query("SELECT state, attempts, ticket_id FROM push_jobs ORDER BY id")
      .all(),
  ).toEqual([
    { state: "receipt", attempts: 1, ticket_id: `ticket-${first.id}` },
    { state: "pending", attempts: 0, ticket_id: null },
  ]);
  store.db.exec("DROP TRIGGER fail_ticket");
  await worker.tick(now + 1000);
  expect(sent).toEqual([[first.id, second.id], [second.id]]);
});

test("a later receipt write failure preserves an already completed alert", async () => {
  const { store } = subscribed();
  store.save(page({ content: "first" }), 30, 300);
  const second = store.save(page({ content: "second" }), 30, 300);
  const worker = new PushWorker(store, async (url) =>
    url.endsWith("send")
      ? Response.json({
          data: [
            { status: "ok", id: "ticket-1" },
            { status: "ok", id: "ticket-2" },
          ],
        })
      : Response.json({
          data: {
            "ticket-1": { status: "ok" },
            "ticket-2": { status: "ok" },
          },
        }),
  );
  const now = Date.now();
  await worker.tick(now);
  store.db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON push_jobs
    WHEN NEW.message_id = ${second.id} AND NEW.state = 'sent'
    BEGIN SELECT RAISE(ABORT, 'simulated receipt write failure'); END;`);
  await expect(worker.tick(now + 15 * 60000)).rejects.toThrow(
    "simulated receipt write failure",
  );
  expect(
    store.db.query("SELECT state, attempts FROM push_jobs ORDER BY id").all(),
  ).toEqual([
    { state: "sent", attempts: 2 },
    { state: "receipt", attempts: 1 },
  ]);
});

test("malformed send tickets retry without disabling the token", async () => {
  for (const ticket of [
    null,
    {},
    { status: "unknown" },
    { status: "ok" },
    { status: "ok", id: 42 },
    { details: { error: "DeviceNotRegistered" } },
  ]) {
    const { store, device } = subscribed();
    store.save(page(), 30, 300);
    let requests = 0;
    const worker = new PushWorker(store, async () => {
      requests++;
      return Response.json({ data: [ticket] });
    });
    const now = Date.now() + 1000;
    await worker.tick(now);
    expect(store.authenticate(device.token)?.expoPushToken).toBe(
      "ExpoPushToken[test]",
    );
    expect(store.db.query("SELECT state, error FROM push_jobs").get()).toEqual({
      state: "pending",
      error: "Invalid push ticket",
    });
    await worker.tick(now + 999);
    expect(requests).toBe(1);
    await worker.tick(now + 1000);
    expect(requests).toBe(2);
  }
});

test("missing and malformed receipts retry receipt lookup without resending or disabling the token", async () => {
  for (const receipt of [
    undefined,
    null,
    {},
    { status: "unknown" },
    { details: { error: "DeviceNotRegistered" } },
  ]) {
    const { store, device } = subscribed();
    store.save(page(), 30, 7200);
    const requests: string[] = [];
    const worker = new PushWorker(store, async (url) => {
      requests.push(url);
      return url.endsWith("send")
        ? Response.json({ data: [{ status: "ok", id: "ticket" }] })
        : Response.json({ data: { ticket: receipt } });
    });
    const now = Date.now();
    await worker.tick(now);
    await worker.tick(now + 15 * 60000);
    expect(store.dueJobs("pending", now + 15 * 60000)).toEqual([]);
    expect(store.authenticate(device.token)?.expoPushToken).toBe(
      "ExpoPushToken[test]",
    );
    await worker.tick(now + 15 * 60000 + 2000);
    expect(requests.map((url) => url.split("/").at(-1))).toEqual([
      "send",
      "getReceipts",
      "getReceipts",
    ]);
    expect(
      store.db
        .query("SELECT state, ticket_id, sent_token FROM push_jobs")
        .get(),
    ).toEqual({
      state: "receipt",
      ticket_id: "ticket",
      sent_token: "ExpoPushToken[test]",
    });
  }
});

test("non-OK push and receipt responses cancel their streams before retrying", async () => {
  const { store } = subscribed();
  store.save(page(), 30, 300);
  let cancellations = 0;
  let failSend = true;
  const worker = new PushWorker(store, async (url) => {
    if (url.endsWith("send") && !failSend)
      return Response.json({ data: [{ status: "ok", id: "ticket" }] });
    return new Response(
      new ReadableStream({
        cancel() {
          cancellations++;
        },
      }),
      { status: 503 },
    );
  });
  const now = Date.now() + 1000;
  await worker.tick(now);
  expect(cancellations).toBe(1);
  expect(worker.lastError).toBe("Expo HTTP 503");
  expect(store.pendingCount()).toBe(1);
  failSend = false;
  await worker.tick(now + 1000);
  await worker.tick(now + 1000 + 15 * 60000);
  expect(cancellations).toBe(2);
  expect(store.pendingCount()).toBe(0);
  expect(store.db.query("SELECT state, error FROM push_jobs").get()).toEqual({
    state: "receipt",
    error: "Expo HTTP 503",
  });
});

test("push errors persist through idle ticks and clear after successful send or receipt recovery", async () => {
  const { store } = subscribed();
  store.save(page({ content: "first" }), 0, 300);
  store.save(page({ content: "second" }), 0, 300);
  let requests = 0;
  const worker = new PushWorker(store, async (url) => {
    requests++;
    if (requests === 1)
      return Response.json({
        data: [
          { status: "error", details: { error: "MessageRateExceeded" } },
          { status: "ok", id: "second" },
        ],
      });
    if (url.endsWith("send"))
      return Response.json({ data: [{ status: "ok", id: "first" }] });
    if (requests === 3) throw new Error("receipt offline");
    return Response.json({
      data: { first: { status: "ok" }, second: { status: "ok" } },
    });
  });
  const now = Date.now() + 1000;
  await worker.tick(now);
  expect(worker.lastError).toBe("MessageRateExceeded");
  await worker.tick(now + 999);
  expect(requests).toBe(1);
  expect(worker.lastError).toBe("MessageRateExceeded");
  await worker.tick(now + 1000);
  expect(worker.lastError).toBeNull();
  await worker.tick(now + 15 * 60000);
  expect(worker.lastError).toBe("receipt offline");
  await worker.tick(now + 15 * 60000 + 999);
  expect(worker.lastError).toBe("receipt offline");
  await worker.tick(now + 15 * 60000 + 2000);
  expect(worker.lastError).toBeNull();
});

test("unrecognized provider errors are stored as a generic notification error", async () => {
  const { store } = subscribed();
  store.save(page(), 30, 300);
  const worker = new PushWorker(store, async () =>
    Response.json({
      data: [
        { status: "error", details: { error: "private provider details" } },
      ],
    }),
  );
  await worker.tick();
  expect(worker.lastError).toBe("Expo notification error");
  expect(store.db.query("SELECT state, error FROM push_jobs").get()).toEqual({
    state: "pending",
    error: "Expo notification error",
  });
});

test("an unregistered current token is disabled when its receipt fails", async () => {
  const { store, device } = subscribed();
  store.save(page(), 30, 300);
  const worker = new PushWorker(store, async (url) =>
    url.endsWith("send")
      ? Response.json({ data: [{ status: "ok", id: "ticket" }] })
      : Response.json({
          data: {
            ticket: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
  );
  const now = Date.now();
  await worker.tick(now);
  await worker.tick(now + 15 * 60000);
  expect(store.authenticate(device.token)?.expoPushToken).toBeNull();
  expect(store.pendingCount()).toBe(0);
  expect(
    store.db
      .query("SELECT state, error FROM push_jobs WHERE ticket_id = ?")
      .get("ticket"),
  ).toEqual({ state: "failed", error: "DeviceNotRegistered" });
});

test("expired alerts remain in history and never reach the push transport", async () => {
  const { store } = subscribed();
  store.save(
    page({ receivedAt: new Date(Date.now() - 600000).toISOString() }),
    30,
    300,
  );
  const worker = new PushWorker(store, async () => {
    throw new Error("transport should not run");
  });
  await worker.tick();
  expect(worker.lastError).toBeNull();
  expect(store.list({ limit: 10 }).messages).toHaveLength(1);
  expect(store.pendingCount()).toBe(0);
});

test("receipt expiry uses the ticket submission time before transport", async () => {
  for (const deferred of [false, true]) {
    const { store } = subscribed();
    const now = Date.now() + 1000;
    const receivedAt = new Date(now - 23 * 3600000).toISOString();
    store.save(page({ receivedAt }), 30, 86400);
    const deadline = now + 24 * 3600000;
    let requests = 0;
    const worker = new PushWorker(store, async (url) => {
      requests++;
      return url.endsWith("send")
        ? Response.json({ data: [{ status: "ok", id: "ticket" }] })
        : Response.json({ data: { ticket: { status: "ok" } } });
    });
    await worker.tick(now);
    expect(
      store.dueJobs("receipt", Date.parse(receivedAt) + 24 * 3600000),
    ).toHaveLength(1);
    expect(store.dueJobs("receipt", deadline - 1)).toHaveLength(1);
    if (deferred)
      store.db
        .query("UPDATE push_jobs SET next_attempt = ?")
        .run(deadline + 10000);
    await worker.tick(deadline + (deferred ? 1 : 0));
    expect(requests).toBe(1);
    expect(store.db.query("SELECT state FROM push_jobs").get()).toEqual({
      state: "expired",
    });
  }
});

test("ticket timestamps survive reopening and existing receipt rows migrate without replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subpager-receipts-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  let store = new Store(path);
  const device = store.addDevice("test");
  store.registerDevice(device.id, "ExpoPushToken[test]");
  const now = Date.now() + 1000;
  store.save(page({ receivedAt: new Date(now).toISOString() }), 0, 300);
  const legacy = store.dueJobs("pending", now)[0]!;
  store.setJob(legacy, "receipt", now, null, "legacy", legacy.expoPushToken);
  store.db.exec("ALTER TABLE push_jobs DROP COLUMN ticket_at");
  store.close();

  store = new Store(path);
  expect(
    store.db.query("SELECT state, ticket_id, ticket_at FROM push_jobs").get(),
  ).toEqual({
    state: "receipt",
    ticket_id: "legacy",
    ticket_at: null,
  });
  const receivedAt = new Date(now - 23 * 3600000).toISOString();
  store.save(page({ receivedAt, content: "late submission" }), 0, 86400);
  const worker = new PushWorker(store, async (url) =>
    url.endsWith("send")
      ? Response.json({ data: [{ status: "ok", id: "late" }] })
      : Response.json({ data: { legacy: { status: "ok" } } }),
  );
  await worker.tick(now + 1000);
  store.close();
  store = new Store(path);
  stores.push(store);
  const receipts = store.dueJobs("receipt", now + 3600000);
  expect(receipts.map((job) => job.ticketId)).toEqual(["late"]);
  expect(
    store.db
      .query("SELECT ticket_at FROM push_jobs WHERE ticket_id = 'late'")
      .get(),
  ).toEqual({
    ticket_at: now + 1000,
  });
  expect(store.dueJobs("receipt", now + 1000 + 24 * 3600000)).toEqual([]);
});

test("unregistered push tokens are disabled and accepted old-token receipts do not disable a newer token", async () => {
  const { store, device } = subscribed("ExpoPushToken[old]");
  store.save(page(), 30, 300);
  const worker = new PushWorker(store, async (url) =>
    url.endsWith("send")
      ? Response.json({ data: [{ status: "ok", id: "old-ticket" }] })
      : Response.json({
          data: {
            "old-ticket": {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
  );
  const now = Date.now();
  await worker.tick(now);
  store.registerDevice(device.id, "ExpoPushToken[new]");
  await worker.tick(now + 15 * 60000 + 1);
  expect(store.authenticate(device.token)?.expoPushToken).toBe(
    "ExpoPushToken[new]",
  );
});

test("config rejects unsafe numbers but accepts automatic gain defaults", () => {
  expect(() => validateConfig(structuredClone(defaultConfig))).not.toThrow();
  expect(() =>
    validateConfig({ ...defaultConfig, dedupeSeconds: NaN }),
  ).toThrow();
  expect(() =>
    validateConfig({
      ...defaultConfig,
      radio: { ...defaultConfig.radio, gain: "max" },
    }),
  ).toThrow();
});

test("receipt failures never resurrect an old token after subscription changes", async () => {
  const { store, device } = subscribed("ExpoPushToken[old]");
  store.save(page(), 30, 300);
  const worker = new PushWorker(store, async (url) =>
    url.endsWith("send")
      ? Response.json({ data: [{ status: "ok", id: "old-ticket" }] })
      : Response.json({
          data: {
            "old-ticket": {
              status: "error",
              details: { error: "MessageRateExceeded" },
            },
          },
        }),
  );
  const now = Date.now();
  await worker.tick(now);
  store.registerDevice(device.id, "ExpoPushToken[new]");
  await worker.tick(now + 15 * 60000 + 1);
  expect(store.pendingCount()).toBe(0);
  expect(
    store.db.query<{ state: string }, []>("SELECT state FROM push_jobs").get()
      ?.state,
  ).toBe("failed");
});

test("WAVs attach to each matching message without overwriting existing audio", () => {
  const store = memory();
  const call = page();
  const repeat = page({
    receivedAt: new Date(Date.parse(call.receivedAt) + 1000).toISOString(),
  });
  const first = store.save(call, 30, 300);
  const repeated = store.save(repeat, 30, 300);
  const wav = Uint8Array.from([82, 73, 70, 70, 0, 255, 42]);
  expect(store.saveRecording(wav, [call, repeat, call])).toEqual([
    first.id,
    repeated.id,
  ]);
  expect(store.getRecording(first.id)).toEqual({ wav });
  expect(store.getRecording(repeated.id)).toEqual({ wav });
  expect(store.saveRecording(Uint8Array.from([1]), [call, repeat])).toEqual([
    first.id,
    repeated.id,
  ]);
  expect(store.getRecording(first.id)).toEqual({ wav });
  const nextCall = page({ content: "next live call" });
  const next = store.save(nextCall, 30, 300);
  const nextWav = Uint8Array.from([7, 8]);
  expect(store.saveRecording(nextWav, [call, nextCall])).toEqual([
    first.id,
    next.id,
  ]);
  expect(store.getRecording(first.id)).toEqual({ wav });
  expect(store.getRecording(next.id)).toEqual({ wav: nextWav });
});

test("unmatched audio is ignored and a failed multi-message attachment rolls back", () => {
  const store = memory();
  const call = page();
  expect(store.saveRecording(Uint8Array.from([1, 2]), [call])).toEqual([]);
  const first = store.save(call, 0, 300);
  const secondCall = page({ content: "second call" });
  const second = store.save(secondCall, 0, 300);
  store.db.exec(`CREATE TRIGGER fail_audio BEFORE UPDATE OF wav ON messages
    WHEN NEW.id = ${second.id}
    BEGIN SELECT RAISE(ABORT, 'simulated audio write failure'); END;`);
  expect(() =>
    store.saveRecording(Uint8Array.from([1, 2]), [call, secondCall]),
  ).toThrow("simulated audio write failure");
  expect(store.getRecording(first.id)).toBeNull();
  expect(store.getRecording(second.id)).toBeNull();
});

test("recordings survive reopening and a manual backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "subpager-recordings-"));
  directories.push(directory);
  const path = join(directory, "messages.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  let store = new Store(path);
  const call = page();
  const message = store.save(call, 30, 300);
  const wav = Uint8Array.from([82, 73, 70, 70, 0, 128, 255, 42]);
  store.saveRecording(wav, [call]);
  store.close();
  store = new Store(path);
  stores.push(store);
  expect(store.getRecording(message.id)).toEqual({ wav });
  store.backup(backupPath);
  const backup = new Store(backupPath);
  stores.push(backup);
  expect(backup.getMessage(message.id)).toEqual(message);
  expect(backup.getRecording(message.id)).toEqual({ wav });
  expect(backup.saveRecording(wav, [call])).toEqual([message.id]);
});

test("backup command refuses a missing source database and preserves existing destinations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subpager-backup-"));
  directories.push(directory);
  const configPath = join(directory, "config.json");
  const databasePath = join(directory, "source.sqlite");
  const outputPath = join(directory, "backup.sqlite");
  await Bun.write(
    configPath,
    JSON.stringify({ ...defaultConfig, database: databasePath }),
  );
  const runBackup = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import { backup } from "./scripts/tools"; await backup(Bun.argv[1])',
        outputPath,
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, SUBPAGER_CONFIG: configPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  const missing = await runBackup();
  expect(missing.exit).not.toBe(0);
  expect(missing.stderr).toContain("Database not found:");
  expect(await Bun.file(databasePath).exists()).toBe(false);
  expect(await Bun.file(outputPath).exists()).toBe(false);

  const source = new Store(databasePath);
  const message = source.save(page(), 0, 300);
  source.close();
  expect((await runBackup()).exit).toBe(0);
  const snapshot = new Store(outputPath);
  expect(snapshot.getMessage(message.id)).toEqual(message);
  snapshot.close();
  const before = await Bun.file(outputPath).bytes();
  expect((await runBackup()).exit).not.toBe(0);
  expect(await Bun.file(outputPath).bytes()).toEqual(before);
});

test("recording API preserves exact WAV bytes and requires a valid device key", async () => {
  const store = memory();
  const device = store.addDevice("audio test");
  const call = page();
  const message = store.save(call, 30, 300);
  const withoutAudio = store.save(page({ content: "no recording" }), 30, 300);
  const wav = Uint8Array.from([
    9, 82, 73, 70, 70, 0, 127, 128, 255, 42, 9,
  ]).subarray(1, 10);
  store.saveRecording(wav, [call]);
  store.getRecording = (id) => (id === message.id ? { wav } : null);
  const handler = handlerFor(store);
  const url = `https://test/v1/messages/${message.id}/audio`;
  const headers = { authorization: `Bearer ${device.token}` };
  expect((await handler(new Request(url))).status).toBe(401);
  const audio = await handler(new Request(url, { headers }));
  expect(audio.status).toBe(200);
  expect(audio.headers.get("content-type")).toBe("audio/wav");
  expect(audio.headers.get("content-length")).toBe(String(wav.byteLength));
  expect(audio.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(wav);
  for (const id of [withoutAudio.id, 999999]) {
    expect(
      (
        await handler(
          new Request(`https://test/v1/messages/${id}/audio`, { headers }),
        )
      ).status,
    ).toBe(404);
  }
  store.revokeDevice(device.id);
  expect((await handler(new Request(url, { headers }))).status).toBe(401);
});

test("direct audio attachment is idempotent across repeated calls and normalized terminators", () => {
  const store = memory();
  const page: Page = {
    receivedAt: new Date().toISOString(),
    ric: 790241,
    function: 3,
    type: "alpha",
    content: "CALL<EOT><NUL>",
  };
  const first = store.save(page, 30, 300);
  const repeated = store.save({ ...page, content: "CALL" }, 30, 300);
  expect(repeated.duplicateOf).toBe(first.id);
  const wav = new Uint8Array([1, 2, 3]);
  expect(store.saveRecording(wav, [page])).toEqual([first.id, repeated.id]);
  expect(store.saveRecording(new Uint8Array([9]), [page])).toEqual([
    first.id,
    repeated.id,
  ]);
  expect(store.getRecording(repeated.id)?.wav).toEqual(wav);
});

test("completed push jobs retain at most 1000 rows without deleting pending or receipt work", () => {
  const store = memory();
  const receivedAt = new Date().toISOString();
  store.db
    .exec(`INSERT INTO devices (id, name, token_hash, expo_push_token) VALUES ('device', 'phone', 'hash', 'ExpoPushToken[test]');
    WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 1007)
    INSERT INTO messages (id, received_at, ric, function, type, content)
      SELECT id, '${receivedAt}', 790241, 3, 'alpha', 'CALL' FROM ids;
    INSERT INTO push_jobs (id, device_id, message_id, state, next_attempt, expires_at)
      SELECT id, 'device', id, CASE WHEN id = 1006 THEN 'pending' WHEN id = 1007 THEN 'receipt' ELSE 'sent' END, 0, 9999999999999 FROM messages;`);
  expect(store.dueJobs("pending", Date.now())).toHaveLength(1);
  expect(store.dueJobs("receipt", Date.now())).toHaveLength(1);
  expect(
    store.db
      .query("SELECT count(*) AS count FROM push_jobs WHERE state = 'sent'")
      .get(),
  ).toEqual({ count: 1000 });
  expect(
    store.db
      .query("SELECT min(id) AS id FROM push_jobs WHERE state = 'sent'")
      .get(),
  ).toEqual({ id: 6 });
});
