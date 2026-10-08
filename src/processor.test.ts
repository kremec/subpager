import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { PushDelivery, type PushJob } from "./delivery";
import { FirestoreJobsProcessor } from "./processor";
import {
  LocationExtraction,
  locationRetry,
  parseLocation,
  readLocationResponse,
  type LocationJob,
} from "./location";

type Data = Record<string, unknown>;
interface Reference {
  path: string;
  id: string;
}
interface Query {
  collection: string;
  field: string;
  value: unknown;
}
interface Listener {
  name: string;
  next: (snapshot: { docs: ReturnType<TestFirestore["snapshot"]>[] }) => void;
  error: () => void;
  closed: boolean;
}

// Only the SDK calls used by the jobs. No Firebase connection or credentials.
class TestFirestore {
  docs = new Map<string, Data>();
  versions = new Map<string, Timestamp>();
  listeners: Listener[] = [];
  rejectWrite?: (path: string, patch: Data) => boolean;
  db = this as unknown as Firestore;

  put(path: string, value: Data) {
    this.docs.set(path, value);
    const previous = this.versions.get(path)?.toMillis() ?? 0;
    this.versions.set(path, Timestamp.fromMillis(previous + 1));
  }

  collection(name: string) {
    return {
      doc: (id: string): Reference => ({ id, path: `${name}/${id}` }),
      where: (field: string, _operator: string, value: unknown) => ({
        collection: name,
        field,
        value,
        onSnapshot: (next: Listener["next"], error: Listener["error"]) => {
          const listener = { name, next, error, closed: false };
          this.listeners.push(listener);
          return () => {
            listener.closed = true;
          };
        },
      }),
    };
  }

  snapshot(ref: Reference) {
    const data = this.docs.get(ref.path);
    return {
      id: ref.id,
      ref,
      exists: data !== undefined,
      updateTime: this.versions.get(ref.path),
      data: () => data,
      get: (field: string) => data?.[field],
    };
  }

  async runTransaction<T>(
    callback: (transaction: {
      get: (
        target: Reference | Query,
      ) => Promise<
        | ReturnType<TestFirestore["snapshot"]>
        | { docs: ReturnType<TestFirestore["snapshot"]>[] }
      >;
      getAll: (
        ...references: Reference[]
      ) => Promise<ReturnType<TestFirestore["snapshot"]>[]>;
      update: (reference: Reference, patch: Data) => void;
    }) => Promise<T>,
  ) {
    const writes: { reference: Reference; patch: Data }[] = [];
    const result = await callback({
      get: async (target) => {
        if ("path" in target) return this.snapshot(target);
        const docs = [...this.docs.entries()]
          .filter(
            ([path, data]) =>
              path.startsWith(`${target.collection}/`) &&
              data[target.field] === target.value,
          )
          .map(([path]) => this.snapshot({ path, id: path.split("/")[1]! }));
        return { docs };
      },
      getAll: async (...references) =>
        references.map((reference) => this.snapshot(reference)),
      update: (reference, patch) => {
        writes.push({ reference, patch });
      },
    });
    if (
      writes.some(({ reference, patch }) =>
        this.rejectWrite?.(reference.path, patch),
      )
    )
      throw new Error("Simulated Firestore write outage");
    for (const { reference, patch } of writes) {
      const data = { ...this.docs.get(reference.path) };
      for (const [key, value] of Object.entries(patch)) {
        if (value instanceof FieldValue && value.isEqual(FieldValue.delete()))
          delete data[key];
        else data[key] = value;
      }
      this.put(reference.path, data);
    }
    return result;
  }
}

const now = 1_800_000_000_000;
afterEach(() => setSystemTime());

function pushFixture(
  store: TestFirestore,
  id = "push",
  overrides: Partial<PushJob> = {},
) {
  store.put(`devices/${id}`, { expoPushToken: `token-${id}` });
  store.put(`members/${id}`, { approved: true });
  const job: PushJob = {
    active: true,
    state: "pending",
    messageId: "message",
    deviceId: id,
    expoPushToken: `token-${id}`,
    tokenUpdatedAt: store.versions.get(`devices/${id}`)!,
    title: "0790793 · 08/10/2026, 08:57",
    body: "VAJA GORI V ŠOLI GOLO.",
    expiresAt: now + 300_000,
    nextAttempt: now,
    attempts: 0,
    leaseUntil: 0,
    ...overrides,
  };
  store.put(`pushJobs/${id}`, { ...job });
}

function locationFixture(
  store: TestFirestore,
  id = "location",
  overrides: Partial<LocationJob> = {},
) {
  const job: LocationJob = {
    active: true,
    state: "pending",
    messageId: id,
    content: "GORI V ŠOLI GOLO.",
    nextAttempt: now,
    attempts: 0,
    failures: 0,
    leaseUntil: 0,
    ...overrides,
  };
  store.put(`locationJobs/${id}`, { ...job });
  store.put(`messages/${id}`, { content: job.content, duplicateOf: null });
}

const openAIResult = () =>
  Response.json({
    status: "completed",
    output: [
      { content: [{ type: "output_text", text: '{"location":"ŠOLI GOLO"}' }] },
    ],
  });

describe("durable Expo jobs", () => {
  test("keeps accepted tickets when another error has malformed details", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "one");
    pushFixture(store, "two");
    const worker = new PushDelivery(store.db, async () =>
      Response.json({
        data: [
          { status: "ok", id: "ticket" },
          { status: "error", details: { error: { bad: true } } },
        ],
      }),
    );
    await worker.run(["one", "two"]);
    expect(store.docs.get("pushJobs/one")).toMatchObject({
      state: "receipt",
      ticketId: "ticket",
      nextAttempt: now + 900_000,
      receiptExpiresAt: now + 86_400_000,
    });
    expect(store.docs.get("pushJobs/two")).toMatchObject({
      state: "pending",
      lastError: "Expo notification error",
      leaseUntil: 0,
    });
  });

  test("short ticket arrays preserve accepted entries and retry missing entries", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "one");
    pushFixture(store, "two");
    await new PushDelivery(store.db, async () =>
      Response.json({ data: [{ status: "ok", id: "ticket" }] }),
    ).run(["one", "two"]);
    expect(store.docs.get("pushJobs/one")?.state).toBe("receipt");
    expect(store.docs.get("pushJobs/two")?.state).toBe("pending");
  });

  test("rechecks approval and token but permits registration of the same token", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "revoked");
    pushFixture(store, "rotated");
    pushFixture(store, "same");
    store.put("members/revoked", { approved: false });
    store.put("devices/rotated", { expoPushToken: "new-token" });
    store.put("devices/same", { expoPushToken: "token-same" });
    let sent = 0;
    await new PushDelivery(store.db, async (_url, options) => {
      const body = JSON.parse(options.body as string) as {
        to: string;
        title: string;
        body: string;
      }[];
      expect(body.map((job) => job.to)).toEqual(["token-same"]);
      expect(body[0]?.title).toBe("0790793 · 08/10/2026, 08:57");
      expect(body[0]?.body).toBe("VAJA GORI V ŠOLI GOLO.");
      sent++;
      return Response.json({ data: [{ status: "ok", id: "ticket" }] });
    }).run(["revoked", "rotated", "same"]);
    expect(sent).toBe(1);
    expect(store.docs.get("pushJobs/revoked")?.active).toBe(false);
    expect(store.docs.get("pushJobs/rotated")?.active).toBe(false);
  });

  test("old DeviceNotRegistered receipts cannot erase a newer token registration", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "old", {
      state: "receipt",
      ticketId: "old-ticket",
      receiptExpiresAt: now + 86_400_000,
    });
    pushFixture(store, "current", {
      state: "receipt",
      ticketId: "current-ticket",
      receiptExpiresAt: now + 86_400_000,
    });
    store.put("devices/old", { expoPushToken: "token-old" });
    await new PushDelivery(store.db, async () =>
      Response.json({
        data: {
          "old-ticket": {
            status: "error",
            details: { error: "DeviceNotRegistered" },
          },
          "current-ticket": {
            status: "error",
            details: { error: "DeviceNotRegistered" },
          },
        },
      }),
    ).run(["old", "current"]);
    expect(store.docs.get("devices/old")?.expoPushToken).toBe("token-old");
    expect(store.docs.get("devices/current")?.expoPushToken).toBeUndefined();
  });

  test("accepted ticket survives a failed database write without sending again", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    let requests = 0;
    const worker = new PushDelivery(store.db, async () => {
      requests++;
      return Response.json({ data: [{ status: "ok", id: "ticket" }] });
    });
    store.rejectWrite = (_path, patch) => patch.state === "receipt";
    await expect(worker.run(["push"])).rejects.toThrow("write outage");
    store.rejectWrite = undefined;
    await worker.run(["push"]);
    expect(requests).toBe(1);
    expect(store.docs.get("pushJobs/push")?.ticketId).toBe("ticket");
  });

  test("stale attempt cannot finish a job claimed by another worker", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    await new PushDelivery(store.db, async () => {
      store.put("pushJobs/push", {
        ...store.docs.get("pushJobs/push"),
        attempts: 2,
      });
      return Response.json({ data: [{ status: "ok", id: "stale-ticket" }] });
    }).run(["push"]);
    expect(store.docs.get("pushJobs/push")?.ticketId).toBeUndefined();
  });

  test("leased and expired jobs do not call Expo", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "leased", { leaseUntil: now + 30_000 });
    pushFixture(store, "expired", { expiresAt: now });
    pushFixture(store, "receipt", { state: "receipt", receiptExpiresAt: now });
    let requests = 0;
    await new PushDelivery(store.db, async () => {
      requests++;
      throw new Error("unexpected");
    }).run(["leased", "expired", "receipt"]);
    expect(requests).toBe(0);
    expect(store.docs.get("pushJobs/expired")?.state).toBe("expired");
    expect(store.docs.get("pushJobs/receipt")?.state).toBe("expired");
  });
});

describe("durable location jobs", () => {
  test("yields after one paid request instead of draining a shutdown backlog", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store, "one");
    locationFixture(store, "two");
    let requests = 0;
    await new LocationExtraction(store.db, "test-key", undefined, async () => {
      requests++;
      return openAIResult();
    }).run(["one", "two"]);
    expect(requests).toBe(1);
    expect(store.docs.get("locationJobs/one")?.state).toBe("ready");
    expect(store.docs.get("locationJobs/two")?.attempts).toBe(0);
  });
  test("requires exact source substrings and a completed single response", () => {
    expect(
      parseLocation('{"location":"PODREČJE 8B"}', "DOMŽALE, PODREČJE 8B."),
    ).toBe("PODREČJE 8B");
    expect(parseLocation('{"location":null}', "KANAL 15")).toBeNull();
    expect(() =>
      parseLocation('{"location":"OŠ Golo"}', "GORI V ŠOLI GOLO."),
    ).toThrow();
    expect(() => parseLocation('{"location":" GOLO "}', " GOLO ")).toThrow();
    expect(() =>
      readLocationResponse({ status: "incomplete", output: [] }),
    ).toThrow();
    expect(() =>
      readLocationResponse({
        status: "completed",
        output: [{ content: [{ type: "refusal" }] }],
      }),
    ).toThrow();
  });

  test("paid result survives persistence failure and enriches repeats without more inference", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store);
    store.put("messages/repeat", { duplicateOf: "location" });
    let requests = 0;
    const worker = new LocationExtraction(
      store.db,
      "test-key",
      undefined,
      async (_url, options) => {
        const request = JSON.parse(options.body as string) as {
          model: string;
          reasoning: { effort: string };
          stream?: boolean;
        };
        expect(request.model).toBe("gpt-6-luna");
        expect(request.reasoning.effort).toBe("none");
        expect(request.stream).toBeUndefined();
        requests++;
        return openAIResult();
      },
    );
    store.rejectWrite = (_path, patch) => patch.state === "ready";
    await expect(worker.run(["location"])).rejects.toThrow("write outage");
    store.rejectWrite = undefined;
    await worker.run(["location"]);
    expect(requests).toBe(1);
    expect(store.docs.get("messages/location")?.location).toBe("ŠOLI GOLO");
    expect(store.docs.get("messages/repeat")?.location).toBe("ŠOLI GOLO");
    expect(store.docs.get("locationJobs/location")?.active).toBe(false);
  });

  test("persisted ready result publishes after restart even while inference is paused", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store, "ready", { state: "ready", result: null });
    locationFixture(store, "pending");
    let requests = 0;
    const worker = new LocationExtraction(
      store.db,
      "test-key",
      undefined,
      async () => {
        requests++;
        return openAIResult();
      },
    );
    worker.pausedUntil = now + 3_600_000;
    await worker.run(["pending", "ready"]);
    expect(requests).toBe(0);
    expect(store.docs.get("messages/ready")?.location).toBeNull();
    expect(store.docs.get("locationJobs/pending")?.state).toBe("pending");
  });

  test("quota pause is durable and does not consume ordinary failure budget", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store);
    const worker = new LocationExtraction(
      store.db,
      "test-key",
      undefined,
      async () => new Response("", { status: 429 }),
    );
    await worker.run(["location"]);
    expect(store.docs.get("locationJobs/location")).toMatchObject({
      active: true,
      state: "pending",
      failures: 0,
      nextAttempt: now + 3_600_000,
      leaseUntil: 0,
      lastError: "OpenAI HTTP 429",
    });
    expect(worker.pausedUntil).toBe(now + 3_600_000);
    expect(locationRetry(4, 429, now).active).toBe(true);
    expect(locationRetry(4, undefined, now).active).toBe(false);
  });

  test("expired inference lease counts as failure instead of repeatedly billing", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store, "crashed", {
      failures: 4,
      attempts: 5,
      leaseUntil: now - 1,
    });
    let requests = 0;
    await new LocationExtraction(store.db, "test-key", undefined, async () => {
      requests++;
      return openAIResult();
    }).run(["crashed"]);
    expect(requests).toBe(0);
    expect(store.docs.get("locationJobs/crashed")).toMatchObject({
      active: false,
      state: "failed",
      failures: 5,
    });
  });
});

test("listener reconnect survives an in-flight job finishing", async () => {
  setSystemTime(now);
  const store = new TestFirestore();
  pushFixture(store);
  interface Timer {
    callback: () => void;
    delay: number;
    cancelled: boolean;
  }
  const timers: Timer[] = [];
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    const timer = {
      callback: () => callback(),
      delay: delay ?? 0,
      cancelled: false,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    (handle) => {
      const timer = timers.find(
        (candidate) => candidate === (handle as unknown),
      );
      if (timer) timer.cancelled = true;
    },
  );
  const logged = spyOn(console, "error").mockImplementation(() => {});
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        requested!();
        await blocked;
        return Response.json({ data: [{ status: "ok", id: "ticket" }] });
      },
      { preconnect: () => {} },
    ),
  );
  const worker = new FirestoreJobsProcessor(store.db);
  try {
    worker.start();
    const listener = store.listeners.find(
      (candidate) => candidate.name === "pushJobs",
    )!;
    listener.next({
      docs: [store.snapshot({ id: "push", path: "pushJobs/push" })],
    });
    timers.find((timer) => timer.delay === 0)!.callback();
    await entered;
    listener.error();
    const reconnect = timers.find((timer) => timer.delay === 30_000)!;
    release!();
    await Bun.sleep(1);
    expect(store.docs.get("pushJobs/push")?.state).toBe("receipt");
    expect(reconnect.cancelled).toBe(false);
    reconnect.callback();
    expect(
      store.listeners.filter((candidate) => candidate.name === "pushJobs"),
    ).toHaveLength(2);
    expect(timers.filter((timer) => timer.delay === 0)).toHaveLength(1);
  } finally {
    release!();
    await worker.stop();
    request.mockRestore();
    logged.mockRestore();
    timeout.mockRestore();
    clear.mockRestore();
  }
});
