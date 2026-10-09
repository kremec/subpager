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
import { PushDelivery, type PushJob, type PushRecipient } from "./delivery";
import { FirestoreUsers } from "./users";
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
  initialUsers = true;
  reads = 0;
  writes = 0;
  deletes = 0;
  loseAcknowledgement = false;
  rejectWrite?: (path: string, patch: Data) => boolean;
  db = this as unknown as Firestore;

  put(path: string, value: Data) {
    if (Array.isArray(value.recipients))
      value = {
        ...value,
        recipients: value.recipients.map((recipient) => ({ ...recipient })),
      };
    this.docs.set(path, value);
    const previous = this.versions.get(path)?.toMillis() ?? 0;
    this.versions.set(path, Timestamp.fromMillis(previous + 1));
  }

  publishUsers() {
    const docs = [...this.docs.keys()]
      .filter((path) => path.startsWith("users/"))
      .map((path) => this.snapshot({ path, id: path.split("/")[1]! }));
    for (const listener of this.listeners)
      if (listener.name === "users" && !listener.closed)
        listener.next({ docs });
  }

  collection(name: string) {
    const onSnapshot = (next: Listener["next"], error: Listener["error"]) => {
      const listener = { name, next, error, closed: false };
      this.listeners.push(listener);
      if (name === "users" && this.initialUsers)
        next({
          docs: [...this.docs.keys()]
            .filter((path) => path.startsWith("users/"))
            .map((path) => this.snapshot({ path, id: path.split("/")[1]! })),
        });
      return () => {
        listener.closed = true;
      };
    };
    return {
      doc: (id: string): Reference => ({ id, path: `${name}/${id}` }),
      onSnapshot,
      where: (field: string, _operator: string, value: unknown) => ({
        collection: name,
        field,
        value,
        onSnapshot,
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
      delete: (reference: Reference) => void;
    }) => Promise<T>,
  ) {
    const writes: { reference: Reference; patch: Data }[] = [];
    const deletes: Reference[] = [];
    const result = await callback({
      get: async (target) => {
        this.reads++;
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
      getAll: async (...references) => {
        this.reads += references.length;
        return references.map((reference) => this.snapshot(reference));
      },
      update: (reference, patch) => {
        writes.push({ reference, patch });
      },
      delete: (reference) => {
        deletes.push(reference);
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
    this.writes += writes.length;
    for (const reference of deletes) this.docs.delete(reference.path);
    this.deletes += deletes.length;
    if (this.loseAcknowledgement)
      throw new Error("Commit acknowledgement lost");
    return result;
  }
}

const now = 1_800_000_000_000;
afterEach(() => setSystemTime());

function pushFixture(
  store: TestFirestore,
  id = "push",
  overrides: Partial<PushJob> = {},
  recipientOverrides: Partial<PushRecipient> = {},
) {
  store.put(`users/${id}`, {
    expoPushToken: `token-${id}`,
    approved: true,
    label: `Device ${id}`,
  });
  const job: PushJob = {
    active: true,
    state: "pending",
    messageId: "message",
    recipients: [
      {
        deviceId: id,
        expoPushToken: `token-${id}`,
        tokenUpdatedAt: store.versions.get(`users/${id}`)!,
        state: "pending",
        nextAttempt: now,
        attempts: 0,
        ...recipientOverrides,
      },
    ],
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

function usersFixture(store: TestFirestore) {
  const users = new FirestoreUsers(store.db);
  void users.ready();
  return users;
}

function recipients(store: TestFirestore, id = "push") {
  return (store.docs.get(`pushJobs/${id}`) as unknown as PushJob).recipients;
}

function mergePushes(store: TestFirestore, ids: string[]) {
  const first = ids[0]!;
  const combined = ids.flatMap((id) => recipients(store, id));
  store.put(`pushJobs/${first}`, {
    ...store.docs.get(`pushJobs/${first}`),
    recipients: combined,
  });
  for (const id of ids.slice(1)) store.docs.delete(`pushJobs/${id}`);
}

describe("durable Expo batches", () => {
  test("100 recipients share one job through sending and receipt checks", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    for (let index = 1; index < 100; index++)
      store.put(`users/${index}`, {
        approved: true,
        expoPushToken: `token-${index}`,
      });
    const users = usersFixture(store);
    store.put("pushJobs/push", {
      ...store.docs.get("pushJobs/push"),
      recipients: users.recipients(),
    });
    const endpoints: string[] = [];
    const worker = new PushDelivery(
      store.db,
      async (url, options) => {
        endpoints.push(url);
        const body = JSON.parse(options.body as string);
        if (url.endsWith("/send")) {
          expect(body).toHaveLength(100);
          return Response.json({
            data: body.map((_value: unknown, index: number) => ({
              status: "ok",
              id: `ticket-${index}`,
            })),
          });
        }
        expect(body.ids).toHaveLength(100);
        return Response.json({
          data: Object.fromEntries(
            body.ids.map((id: string) => [id, { status: "ok" }]),
          ),
        });
      },
      undefined,
      users,
    );
    await worker.run(["push"]);
    expect(store.reads).toBe(2);
    expect(store.writes).toBe(2);
    expect(recipients(store)).toHaveLength(100);
    expect(
      recipients(store).every((recipient) => recipient.state === "receipt"),
    ).toBe(true);
    expect(store.docs.get("pushJobs/push")).toMatchObject({
      nextAttempt: now + 900_000,
      attempts: 1,
    });
    setSystemTime(now + 900_000);
    await new PushDelivery(
      store.db,
      async (url, options) => {
        endpoints.push(url);
        const body = JSON.parse(options.body as string);
        return Response.json({
          data: Object.fromEntries(
            body.ids.map((id: string) => [id, { status: "ok" }]),
          ),
        });
      },
      undefined,
      users,
    ).run(["push"]);
    expect(endpoints).toHaveLength(2);
    expect(store.reads).toBe(4);
    expect(store.writes).toBe(3);
    expect(store.deletes).toBe(1);
    expect(endpoints[1]).toEndWith("/getReceipts");
    expect(store.docs.has("pushJobs/push")).toBe(false);
    users.stop();
  });

  test("mixed and missing ticket results retry only unaccepted recipients", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    for (const id of ["one", "two", "three"]) pushFixture(store, id);
    mergePushes(store, ["one", "two", "three"]);
    const users = usersFixture(store);
    let requests = 0;
    const worker = new PushDelivery(
      store.db,
      async (_url, options) => {
        requests++;
        if (requests === 1)
          return Response.json({
            data: [
              { status: "ok", id: "ticket" },
              { status: "error", details: { error: { bad: true } } },
            ],
          });
        const body = JSON.parse(options.body as string) as { to: string }[];
        expect(body.map((item) => item.to)).toEqual([
          "token-two",
          "token-three",
        ]);
        return Response.json({
          data: [
            { status: "ok", id: "two-ticket" },
            { status: "ok", id: "three-ticket" },
          ],
        });
      },
      undefined,
      users,
    );
    await worker.run(["one"]);
    expect(recipients(store, "one")[0]).toMatchObject({
      state: "receipt",
      ticketId: "ticket",
      receiptExpiresAt: now + 86_400_000,
    });
    expect(recipients(store, "one")[1]).toMatchObject({
      state: "pending",
      lastError: "Expo notification error",
      nextAttempt: now + 1000,
    });
    expect(recipients(store, "one")[2]).toMatchObject({
      state: "pending",
      lastError: "Expo result not available",
    });
    setSystemTime(now + 1000);
    await worker.run(["one"]);
    expect(
      recipients(store, "one").every(
        (recipient) => recipient.state === "receipt",
      ),
    ).toBe(true);
    expect(requests).toBe(2);
    users.stop();
  });

  test("cached approval and token changes suppress recipients but same-token registration is allowed", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    for (const id of ["revoked", "rotated", "same"]) pushFixture(store, id);
    mergePushes(store, ["revoked", "rotated", "same"]);
    const users = usersFixture(store);
    store.put("users/revoked", {
      approved: false,
      expoPushToken: "token-revoked",
    });
    store.put("users/rotated", { approved: true, expoPushToken: "new-token" });
    store.put("users/same", { approved: true, expoPushToken: "token-same" });
    store.publishUsers();
    await new PushDelivery(
      store.db,
      async (_url, options) => {
        const body = JSON.parse(options.body as string) as {
          to: string;
          title: string;
          body: string;
        }[];
        expect(body.map((item) => item.to)).toEqual(["token-same"]);
        expect(body[0]).toMatchObject({
          title: "0790793 · 08/10/2026, 08:57",
          body: "VAJA GORI V ŠOLI GOLO.",
        });
        return Response.json({ data: [{ status: "ok", id: "ticket" }] });
      },
      undefined,
      users,
    ).run(["revoked"]);
    expect(
      recipients(store, "revoked").map((recipient) => recipient.state),
    ).toEqual(["failed", "failed", "receipt"]);
    users.stop();
  });

  test("disconnected user cache pauses pushes instead of authorizing stale data", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    const users = usersFixture(store);
    store.listeners.find((listener) => listener.name === "users")!.error();
    let requests = 0;
    await expect(
      new PushDelivery(
        store.db,
        async () => {
          requests++;
          return Response.json({ data: [] });
        },
        undefined,
        users,
      ).run(["push"]),
    ).rejects.toThrow("User listener disconnected");
    expect(requests).toBe(0);
    expect(store.writes).toBe(0);
    expect(recipients(store)[0]).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(() => users.recipients()).toThrow("disconnected");
    users.stop();
  });

  test("invalid-token receipts cannot erase newer registrations of the same token", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    for (const id of ["old", "current"])
      pushFixture(
        store,
        id,
        { state: "receipt" },
        {
          state: "receipt",
          ticketId: `${id}-ticket`,
          receiptExpiresAt: now + 86_400_000,
        },
      );
    mergePushes(store, ["old", "current"]);
    store.put("users/old", { approved: true, expoPushToken: "token-old" });
    const users = usersFixture(store);
    await new PushDelivery(
      store.db,
      async () =>
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
      undefined,
      users,
    ).run(["old"]);
    expect(store.docs.get("users/old")?.expoPushToken).toBe("token-old");
    expect(store.docs.get("users/current")).toEqual({
      approved: true,
      label: "Device current",
    });
    expect(store.docs.get("pushJobs/old")?.active).toBe(false);
    users.stop();
  });

  test.each(["rejected", "lost"])(
    "accepted tickets survive %s database acknowledgements without resending",
    async (failure) => {
      setSystemTime(now);
      const store = new TestFirestore();
      pushFixture(store);
      const users = usersFixture(store);
      let requests = 0;
      const worker = new PushDelivery(
        store.db,
        async () => {
          requests++;
          store.loseAcknowledgement = failure === "lost";
          return Response.json({ data: [{ status: "ok", id: "ticket" }] });
        },
        undefined,
        users,
      );
      if (failure === "rejected")
        store.rejectWrite = (_path, patch) => patch.state === "receipt";
      await expect(worker.run(["push"])).rejects.toThrow(
        failure === "rejected" ? "write outage" : "acknowledgement lost",
      );
      store.rejectWrite = undefined;
      store.loseAcknowledgement = false;
      await worker.run(["push"]);
      expect(requests).toBe(1);
      expect(recipients(store)[0]?.ticketId).toBe("ticket");
      users.stop();
    },
  );

  test("a stale attempt cannot finish a batch claimed by another worker", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    const users = usersFixture(store);
    await new PushDelivery(
      store.db,
      async () => {
        store.put("pushJobs/push", {
          ...store.docs.get("pushJobs/push"),
          attempts: 2,
        });
        return Response.json({ data: [{ status: "ok", id: "stale-ticket" }] });
      },
      undefined,
      users,
    ).run(["push"]);
    expect(recipients(store)[0]?.ticketId).toBeUndefined();
    users.stop();
  });

  test("leased and expired recipients do not call Expo", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store, "leased", { leaseUntil: now + 30_000 });
    pushFixture(store, "expired", { expiresAt: now });
    pushFixture(
      store,
      "receipt",
      { state: "receipt" },
      { state: "receipt", receiptExpiresAt: now },
    );
    const users = usersFixture(store);
    let requests = 0;
    const worker = new PushDelivery(
      store.db,
      async () => {
        requests++;
        return Response.json({ data: [] });
      },
      undefined,
      users,
    );
    for (const id of ["leased", "expired", "receipt"]) await worker.run([id]);
    expect(requests).toBe(0);
    expect(store.docs.get("pushJobs/expired")?.state).toBe("expired");
    expect(store.docs.get("pushJobs/receipt")?.state).toBe("expired");
    users.stop();
  });
});

test("a slow claim cannot start a request that could outlive its lease", async () => {
  setSystemTime(now);
  const store = new TestFirestore();
  pushFixture(store);
  const users = usersFixture(store);
  const transact = store.runTransaction.bind(store);
  const slowCommit = spyOn(store, "runTransaction").mockImplementation(
    async (callback) => {
      const result = await transact(callback);
      setSystemTime(now + 25_000);
      return result;
    },
  );
  let requests = 0;
  try {
    await new PushDelivery(
      store.db,
      async () => {
        requests++;
        return Response.json({ data: [] });
      },
      undefined,
      users,
    ).run(["push"]);
    expect(requests).toBe(0);
    expect(recipients(store)[0]).toMatchObject({
      state: "pending",
      lastError: "Push lease is too close to expiry",
      nextAttempt: now + 26_000,
    });
  } finally {
    users.stop();
    slowCommit.mockRestore();
  }
});

test("receipt retries retain tickets after message expiry and skip completed recipients", async () => {
  setSystemTime(now);
  const store = new TestFirestore();
  for (const id of ["one", "two"])
    pushFixture(
      store,
      id,
      { state: "receipt", expiresAt: now - 1 },
      {
        state: "receipt",
        ticketId: `${id}-ticket`,
        receiptExpiresAt: now + 86_400_000,
      },
    );
  mergePushes(store, ["one", "two"]);
  const users = usersFixture(store);
  const worker = new PushDelivery(
    store.db,
    async (url, options) => {
      expect(url).toEndWith("/getReceipts");
      const body = JSON.parse(options.body as string) as { ids: string[] };
      if (Date.now() === now) {
        expect(body.ids).toEqual(["one-ticket", "two-ticket"]);
        return Response.json({ data: { "one-ticket": { status: "ok" } } });
      }
      expect(body.ids).toEqual(["two-ticket"]);
      return Response.json({ data: { "two-ticket": { status: "ok" } } });
    },
    undefined,
    users,
  );
  await worker.run(["one"]);
  expect(recipients(store, "one").map((recipient) => recipient.state)).toEqual([
    "sent",
    "receipt",
  ]);
  setSystemTime(now + 1000);
  await worker.run(["one"]);
  expect(store.docs.has("pushJobs/one")).toBe(false);
  users.stop();
});

test("a lost final delete acknowledgement never sends a completed batch again", async () => {
  setSystemTime(now);
  const store = new TestFirestore();
  pushFixture(
    store,
    "push",
    { state: "receipt" },
    {
      state: "receipt",
      ticketId: "ticket",
      receiptExpiresAt: now + 86_400_000,
    },
  );
  const users = usersFixture(store);
  let requests = 0;
  const worker = new PushDelivery(
    store.db,
    async (url) => {
      requests++;
      expect(url).toEndWith("/getReceipts");
      store.loseAcknowledgement = true;
      return Response.json({ data: { ticket: { status: "ok" } } });
    },
    undefined,
    users,
  );
  await expect(worker.run(["push"])).rejects.toThrow("acknowledgement lost");
  expect(store.docs.has("pushJobs/push")).toBe(false);
  store.loseAcknowledgement = false;
  await worker.run(["push"]);
  expect(requests).toBe(1);
  expect(store.deletes).toBe(1);
  users.stop();
});

test("user listener failures reject readiness and require a fresh snapshot after reconnect", async () => {
  const store = new TestFirestore();
  store.initialUsers = false;
  let reconnect: (() => void) | undefined;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => {
    reconnect = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const users = new FirestoreUsers(store.db);
  try {
    const ready = users.ready();
    const first = store.listeners[0]!;
    first.error();
    await expect(ready).rejects.toThrow("disconnected");
    await expect(users.ready()).rejects.toThrow("disconnected");
    reconnect!();
    const refreshed = users.ready();
    expect(store.listeners).toHaveLength(2);
    expect(() => users.recipients()).toThrow("disconnected");
    store.publishUsers();
    await refreshed;
    expect(users.recipients()).toEqual([]);
    users.stop();
    store.listeners[1]!.next({ docs: [] });
    store.listeners[1]!.error();
    expect(() => users.recipients()).toThrow("disconnected");
    await expect(users.ready()).rejects.toThrow("stopped");
  } finally {
    users.stop();
    timeout.mockRestore();
  }
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
    expect(store.docs.has("locationJobs/location")).toBe(false);
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
