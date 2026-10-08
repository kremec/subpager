import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import { parseLocation, readLocationResponse } from "./location";
import schema from "./schema";
import type { PagerMessage } from "./validators";

const modules = {
  "./_generated/server.js": () => import("./_generated/server"),
  "./devices.ts": () => import("./devices"),
  "./messages.ts": () => import("./messages"),
  "./units.ts": () => import("./units"),
  "./receiver.ts": () => import("./receiver"),
  "./location.ts": () => import("./location"),
  "./push.ts": () => import("./push"),
  "./http.ts": () => import("./http"),
};

// Exercise scheduled jobs explicitly. No timer may call the real push service.
const originalTimeout = globalThis.setTimeout;
let timerSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
beforeEach(() => {
  timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(() => 0 as ReturnType<typeof setTimeout> & number, {
      __promisify__: originalTimeout.__promisify__,
    }),
  );
});
afterEach(() => timerSpy.mockRestore());

function message(id = 1): PagerMessage {
  return {
    sourceId: `legacy:${id}`,
    receivedAt: new Date().toISOString(),
    ric: 790793,
    function: 3,
    type: "alpha",
    content: "GORI V ŠOLI GOLO" + (id === 1 ? "" : ` (${id})`),
  };
}

async function approvedDevice(
  t: ReturnType<typeof convexTest<typeof schema.tables>>,
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const identity = t.withIdentity({ subject: userId });
  await identity.mutation(api.devices.register, {
    expoPushToken: "ExpoPushToken[test]",
  });
  await t.mutation(internal.receiver.members, { uid: userId, approved: true });
  return { userId, identity };
}

test("anonymous approval is private, cannot be self-assigned, and token registration preserves it", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const identity = t.withIdentity({ subject: userId });
  expect(await identity.query(api.devices.current, {})).toEqual({
    uid: userId,
    approved: false,
  });
  await identity.mutation(api.devices.register, {});
  await expect(identity.query(api.messages.list, {})).rejects.toThrow(
    "Device approval required",
  );
  await expect(
    identity.mutation(api.devices.register, { approved: true } as never),
  ).rejects.toThrow();
  await t.mutation(internal.receiver.members, { uid: userId, approved: true });
  await identity.mutation(api.devices.register, {
    expoPushToken: "ExpoPushToken[new]",
  });
  expect(await identity.query(api.devices.current, {})).toEqual({
    uid: userId,
    approved: true,
  });
  await identity.mutation(api.devices.register, {});
  expect((await t.query(internal.receiver.devices, {}))[0]?.expoPushToken).toBe(
    "ExpoPushToken[new]",
  );
  await identity.mutation(api.devices.register, { expoPushToken: null });
  expect(
    (await t.query(internal.receiver.devices, {}))[0]?.expoPushToken,
  ).toBeNull();
  await t.mutation(internal.receiver.members, { uid: userId, approved: false });
  await expect(identity.query(api.messages.list, {})).rejects.toThrow(
    "Device approval required",
  );
  await expect(t.query(api.messages.list, {})).rejects.toThrow(
    "Authentication required",
  );
});

test("import and ingest retries do not queue old or duplicate alerts; enrichment keeps one message", async () => {
  const t = convexTest(schema, modules);
  const { identity } = await approvedDevice(t);
  const historical = message(1);
  const live = message(2);
  expect(
    await t.mutation(internal.receiver.ingest, {
      messages: [historical],
      notify: false,
    }),
  ).toEqual({ inserted: 1 });
  await t.mutation(internal.receiver.ingest, {
    messages: [historical],
    notify: true,
  });
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    0,
  );
  await t.mutation(internal.receiver.ingest, {
    messages: [live],
    notify: true,
  });
  await t.mutation(internal.receiver.ingest, {
    messages: [live],
    notify: true,
  });
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    1,
  );
  const enriched = (await identity.query(api.messages.list, {}))[0]!;
  await t.mutation(internal.location.dispatch, { messageId: enriched.id });
  await t.mutation(internal.location.complete, {
    messageId: enriched.id,
    attempt: 1,
    location: "ŠOLI GOLO",
  });
  await t.mutation(internal.receiver.ingest, {
    messages: [live],
    notify: true,
  });
  expect((await identity.query(api.messages.list, {}))[0]?.location).toBe(
    "ŠOLI GOLO",
  );
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    1,
  );
  await expect(
    t.mutation(internal.receiver.ingest, {
      messages: [{ ...live, sourceId: "invalid" }],
      notify: false,
    }),
  ).rejects.toThrow("Invalid pager message");
  await expect(
    t.mutation(internal.receiver.ingest, {
      messages: [{ ...live, content: "DIFFERENT" }],
      notify: false,
    }),
  ).rejects.toThrow("different content");
});

test("native message IDs stay stable across receiver retries and duplicate references", async () => {
  const t = convexTest(schema, modules);
  const { identity } = await approvedDevice(t);
  const first = message(1);
  const repeated = { ...first, sourceId: "legacy:2" };
  await t.mutation(internal.receiver.ingest, {
    messages: [first, repeated],
    notify: false,
  });
  const initial = await identity.query(api.messages.list, {});
  expect(typeof initial[0]!.id).toBe("string");
  expect(initial[0]!.duplicateOf).toBe(initial[1]!.id);
  await t.mutation(internal.receiver.ingest, {
    messages: [first, repeated],
    notify: true,
  });
  const latest = await identity.query(api.messages.list, {});
  expect(latest.map((entry) => entry.id)).toEqual(
    initial.map((entry) => entry.id),
  );
  expect(
    latest.every((entry) => !("sourceId" in entry) && !("enrichment" in entry)),
  ).toBe(true);
  const stored = await t.run((ctx) => ctx.db.query("messages").collect());
  expect(stored.every((entry) => !("id" in entry))).toBe(true);
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    0,
  );
});

test("cloud dedupe normalizes markers and keeps the original fixed repeat window", async () => {
  const t = convexTest(schema, modules);
  await approvedDevice(t);
  const first = message(1);
  const startedAt = Date.parse(first.receivedAt);
  await t.mutation(internal.receiver.ingest, {
    messages: [
      { ...first, content: "ŠOLA<LF>GOLO<EOT><NUL>" },
      {
        ...first,
        sourceId: "legacy:2",
        content: "ŠOLA GOLO",
        receivedAt: new Date(startedAt + 20000).toISOString(),
      },
      {
        ...first,
        sourceId: "legacy:3",
        content: "ŠOLA GOLO",
        receivedAt: new Date(startedAt + 31000).toISOString(),
      },
      {
        ...first,
        sourceId: "legacy:4",
        ric: first.ric + 1,
        content: "ŠOLA GOLO",
      },
    ],
    notify: true,
  });
  const rows = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_source").collect(),
  );
  const original = rows.find((entry) => entry.sourceId === "legacy:1")!;
  expect(original.content).toBe("ŠOLA GOLO");
  expect(rows.find((entry) => entry.sourceId === "legacy:2")?.duplicateOf).toBe(
    original._id,
  );
  expect(
    rows.find((entry) => entry.sourceId === "legacy:3")?.duplicateOf,
  ).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    3,
  );
});

function extractionResponse(location: string | null) {
  const text = JSON.stringify({ location });
  return new Response(
    [
      { type: "response.output_text.delta", delta: text },
      { type: "response.output_text.done", text },
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}

test("cloud extraction publishes one paid result to repeat rows without another push", async () => {
  const t = convexTest(schema, modules);
  await approvedDevice(t);
  const first = message();
  await t.mutation(internal.receiver.ingest, {
    messages: [first, { ...first, sourceId: "legacy:2" }],
    notify: true,
  });
  const canonical = (await t.run((ctx) =>
    ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("duplicateOf"), null))
      .first(),
  ))!;
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "isolated-test-key";
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return extractionResponse("ŠOLI GOLO");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await t.mutation(internal.location.dispatch, { messageId: canonical._id });
    await t.action(internal.location.extract, {
      messageId: canonical._id,
      attempt: 1,
    });
    await t.mutation(internal.location.recover, {
      messageId: canonical._id,
      attempt: 1,
    });
    await t.action(internal.location.extract, {
      messageId: canonical._id,
      attempt: 1,
    });
    expect(requests).toBe(1);
    const completed = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(completed.every((entry) => entry.location === "ŠOLI GOLO")).toBe(
      true,
    );
    expect(completed.every((entry) => entry.enrichment === undefined)).toBe(
      true,
    );
    expect(
      await t.run((ctx) => ctx.db.query("pushJobs").collect()),
    ).toHaveLength(1);
    await t.mutation(internal.receiver.ingest, {
      messages: [{ ...first, sourceId: "legacy:3" }],
      notify: true,
    });
    const repeated = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_source", (q) => q.eq("sourceId", "legacy:3"))
        .unique(),
    );
    expect(repeated?.location).toBe("ŠOLI GOLO");
    expect(repeated?.enrichment).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("failed extraction remains durable while pager push proceeds; stale claims cannot run", async () => {
  const t = convexTest(schema, modules);
  await approvedDevice(t);
  await t.mutation(internal.receiver.ingest, {
    messages: [message()],
    notify: true,
  });
  const row = (await t.run((ctx) => ctx.db.query("messages").first()))!;
  await t.mutation(internal.location.dispatch, { messageId: row._id });
  await t.mutation(internal.location.failed, {
    messageId: row._id,
    attempt: 1,
    error: "OpenAI HTTP 429",
    status: 429,
  });
  const pending = await t.run((ctx) => ctx.db.get(row._id));
  expect(pending?.enrichment?.state).toBe("pending");
  expect(pending?.enrichment?.failures).toBe(0);
  expect(pending!.enrichment!.nextAttempt - Date.now()).toBeGreaterThan(
    3599000,
  );
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    1,
  );
  await t.run((ctx) =>
    ctx.db.patch(row._id, {
      enrichment: { ...pending!.enrichment!, nextAttempt: 0 },
    }),
  );
  await t.mutation(internal.location.dispatch, { messageId: row._id });
  expect(
    await t.query(internal.location.job, { messageId: row._id, attempt: 1 }),
  ).toBeNull();
  await t.mutation(internal.location.complete, {
    messageId: row._id,
    attempt: 1,
    location: "GOLO",
  });
  expect((await t.run((ctx) => ctx.db.get(row._id)))?.location).toBeUndefined();
  await expect(
    t.mutation(internal.location.complete, {
      messageId: row._id,
      attempt: 2,
      location: "OŠ Golo",
    }),
  ).rejects.toThrow("exact source substring");
  await t.mutation(internal.location.failed, {
    messageId: row._id,
    attempt: 2,
    error: "Temporary network failure",
  });
  expect(
    (await t.run((ctx) => ctx.db.get(row._id)))?.enrichment?.failures,
  ).toBe(1);
});

test("location parser rejects rewritten destinations and incomplete streams", async () => {
  expect(parseLocation('{"location":null}', "TEST")).toBeNull();
  expect(() => parseLocation('{"location":"OŠ Golo"}', "ŠOLI GOLO")).toThrow();
  await expect(
    readLocationResponse(
      new Response(
        'data: {"type":"response.output_text.delta","delta":"null"}\n\n',
      ),
    ),
  ).rejects.toThrow("complete consistently");
});

test("transport failure retries durably, revoked approval blocks send, and late results cannot overwrite retry", async () => {
  const t = convexTest(schema, modules);
  const { userId } = await approvedDevice(t);
  await t.mutation(internal.receiver.ingest, {
    messages: [message()],
    notify: true,
  });
  const job = (await t.run((ctx) => ctx.db.query("pushJobs").collect()))[0]!;
  await t.mutation(internal.push.dispatch, { jobIds: [job._id] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("offline");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await t.action(internal.push.deliver, {
      jobs: [{ jobId: job._id, attempt: 1 }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const retried = await t.run((ctx) => ctx.db.get(job._id));
  expect(retried?.state).toBe("pending");
  expect(retried?.leased).toBe(false);
  expect(retried?.error).toBe("offline");
  await t.mutation(internal.push.finish, {
    outcomes: [
      {
        jobId: job._id,
        attempt: 1,
        status: "ticket",
        ticketId: "late",
        ticketAt: Date.now(),
      },
    ],
  });
  expect((await t.run((ctx) => ctx.db.get(job._id)))?.state).toBe("pending");
  await t.run((ctx) => ctx.db.patch(job._id, { nextAttempt: 0 }));
  await t.mutation(internal.push.dispatch, { jobIds: [job._id] });
  expect(
    await t.query(internal.push.transportJobs, {
      jobs: [{ jobId: job._id, attempt: 1 }],
    }),
  ).toHaveLength(0);
  await t.mutation(internal.push.recover, { jobId: job._id, attempt: 2 });
  expect((await t.run((ctx) => ctx.db.get(job._id)))?.leased).toBe(true);
  await t.run((ctx) => ctx.db.patch(job._id, { nextAttempt: 0 }));
  await t.mutation(internal.push.recover, { jobId: job._id, attempt: 2 });
  expect((await t.run((ctx) => ctx.db.get(job._id)))?.error).toBe(
    "Push action did not finish",
  );
  await t.mutation(internal.receiver.members, { uid: userId, approved: false });
  await t.run((ctx) => ctx.db.patch(job._id, { nextAttempt: 0 }));
  await t.mutation(internal.push.dispatch, { jobIds: [job._id] });
  expect((await t.run((ctx) => ctx.db.get(job._id)))?.state).toBe("failed");
});

test("old-token receipt failure protects a replacement token", async () => {
  const t = convexTest(schema, modules);
  const { identity } = await approvedDevice(t);
  await t.mutation(internal.receiver.ingest, {
    messages: [message()],
    notify: true,
  });
  const job = (await t.run((ctx) => ctx.db.query("pushJobs").collect()))[0]!;
  await t.mutation(internal.push.dispatch, { jobIds: [job._id] });
  await t.mutation(internal.push.finish, {
    outcomes: [
      {
        jobId: job._id,
        attempt: 1,
        status: "ticket",
        ticketId: "old",
        ticketAt: Date.now(),
      },
    ],
  });
  await identity.mutation(api.devices.register, {
    expoPushToken: "ExpoPushToken[new]",
  });
  await t.run((ctx) => ctx.db.patch(job._id, { nextAttempt: 0 }));
  await t.mutation(internal.push.dispatch, { jobIds: [job._id] });
  await t.mutation(internal.push.finish, {
    outcomes: [
      {
        jobId: job._id,
        attempt: 2,
        status: "failed",
        error: "DeviceNotRegistered",
      },
    ],
  });
  expect((await t.query(internal.receiver.devices, {}))[0]?.expoPushToken).toBe(
    "ExpoPushToken[new]",
  );
});

test("receipt success completes delivery and a rejected current token is cleared", async () => {
  const t = convexTest(schema, modules);
  await approvedDevice(t);
  await t.mutation(internal.receiver.ingest, {
    messages: [message(1), message(2)],
    notify: true,
  });
  const jobs = await t.run((ctx) => ctx.db.query("pushJobs").collect());
  const jobIds = jobs.map((job) => job._id);
  await t.mutation(internal.push.dispatch, { jobIds });
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, options?: RequestInit) => {
      requestCount++;
      const body = JSON.parse(options!.body as string) as {
        title: string;
        body: string;
      }[];
      expect(body).toHaveLength(2);
      expect(body[0]?.title).toStartWith("0790793 · ");
      expect(body[0]?.body).toBe("GORI V ŠOLI GOLO");
      return Response.json({
        data: [
          { status: "ok", id: "accepted" },
          { status: "ok", id: "invalid" },
        ],
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await t.action(internal.push.deliver, {
      jobs: jobIds.map((jobId) => ({ jobId, attempt: 1 })),
    });
    expect(requestCount).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(jobs[0]!._id)))?.state).toBe(
      "receipt",
    );
    await t.run(async (ctx) => {
      for (const jobId of jobIds) await ctx.db.patch(jobId, { nextAttempt: 0 });
    });
    await t.mutation(internal.push.dispatch, { jobIds });
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          data: {
            accepted: { status: "ok" },
            invalid: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
      { preconnect: originalFetch.preconnect },
    );
    await t.action(internal.push.deliver, {
      jobs: jobIds.map((jobId) => ({ jobId, attempt: 2 })),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect((await t.run((ctx) => ctx.db.get(jobs[0]!._id)))?.state).toBe("sent");
  expect((await t.run((ctx) => ctx.db.get(jobs[1]!._id)))?.state).toBe(
    "failed",
  );
  expect(
    (await t.query(internal.receiver.devices, {}))[0]?.expoPushToken,
  ).toBeNull();
});

test("HTTP receiver authenticates and rejects malformed input without writing messages", async () => {
  const t = convexTest(schema, modules);
  const previous = process.env.RECEIVER_SECRET;
  process.env.RECEIVER_SECRET = "isolated-test-secret";
  try {
    expect(
      (
        await t.fetch("/receiver/ingest", {
          method: "POST",
          body: JSON.stringify({ messages: [message()], notify: false }),
        })
      ).status,
    ).toBe(401);
    const headers = {
      authorization: "Bearer isolated-test-secret",
      "content-type": "application/json",
    };
    for (const body of [
      "{",
      "null",
      "[]",
      JSON.stringify({ messages: [message()], notify: "yes" }),
    ]) {
      expect(
        (await t.fetch("/receiver/ingest", { method: "POST", headers, body }))
          .status,
      ).toBe(400);
    }
    expect(
      await t.run((ctx) => ctx.db.query("messages").collect()),
    ).toHaveLength(0);
    expect(
      (
        await t.fetch("/receiver/ingest", {
          method: "POST",
          headers,
          body: JSON.stringify({ messages: [message()], notify: false }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.fetch("/receiver/location", {
          method: "POST",
          headers,
          body: JSON.stringify({ id: 999, location: null }),
        })
      ).status,
    ).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.RECEIVER_SECRET;
    else process.env.RECEIVER_SECRET = previous;
  }
});

test.each([
  { status: "error", details: { error: { malformed: true } } },
  { status: "ok", id: "" },
])(
  "malformed Expo result preserves other accepted tickets in its batch",
  async (invalid) => {
    const t = convexTest(schema, modules);
    await approvedDevice(t);
    await t.mutation(internal.receiver.ingest, {
      messages: [message(1), message(2)],
      notify: true,
    });
    const jobs = await t.run((ctx) => ctx.db.query("pushJobs").collect());
    await t.mutation(internal.push.dispatch, {
      jobIds: jobs.map((job) => job._id),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ data: [{ status: "ok", id: "accepted" }, invalid] }),
      { preconnect: originalFetch.preconnect },
    );
    try {
      await t.action(internal.push.deliver, {
        jobs: jobs.map((job) => ({ jobId: job._id, attempt: 1 })),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect((await t.run((ctx) => ctx.db.get(jobs[0]!._id)))?.state).toBe(
      "receipt",
    );
    expect((await t.run((ctx) => ctx.db.get(jobs[1]!._id)))?.state).toBe(
      "pending",
    );
  },
);
