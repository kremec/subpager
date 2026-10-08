import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { PagerMessage } from "./validators";

const modules = {
  "./_generated/server.js": () => import("./_generated/server"),
  "./devices.ts": () => import("./devices"),
  "./messages.ts": () => import("./messages"),
  "./units.ts": () => import("./units"),
  "./receiver.ts": () => import("./receiver"),
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
    id,
    receivedAt: new Date().toISOString(),
    ric: 790793,
    function: 3,
    type: "alpha",
    content: "GORI V ŠOLI GOLO",
    duplicateOf: null,
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
  await t.mutation(internal.receiver.location, {
    id: 2,
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
    t.mutation(internal.receiver.location, { id: 2, location: "OŠ Golo" }),
  ).rejects.toThrow("exact message substring");
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
  const repeated = { ...first, id: 2, duplicateOf: 1 };
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
  await t.mutation(internal.receiver.location, { id: 2, location: "GOLO" });
  const latest = await identity.query(api.messages.list, {});
  expect(latest.map((entry) => entry.id)).toEqual(
    initial.map((entry) => entry.id),
  );
  expect(latest[0]!.location).toBe("GOLO");
  expect(
    await t.run((ctx) => ctx.db.query("receiverMessages").collect()),
  ).toHaveLength(2);
  const stored = await t.run((ctx) => ctx.db.query("messages").collect());
  expect(stored.every((entry) => !("id" in entry))).toBe(true);
  expect(await t.run((ctx) => ctx.db.query("pushJobs").collect())).toHaveLength(
    0,
  );
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
