import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { PushDelivery, type PushJob, type PushRecipient } from "./delivery";
import { FirestoreUsers } from "./users";
import { ReceptionMonitor } from "./downtime";
import type { RadioState } from "./radio";
import { FirestoreJobsProcessor } from "./processor";
import {
  LocationExtraction,
  locationRetry,
  parseLocation,
  readLocationResponse,
  type LocationJob,
} from "./location";
import {
  SPIN_MATCHING_HORIZON,
  SpinMatching,
  unlinkSpinEvent,
  type SpinJob,
} from "./spin";
import type { SpinEvent } from "./spin-feed";
import { SpinSync } from "./spin-sync";

type Data = Record<string, unknown>;
interface Reference {
  path: string;
  id: string;
}
interface Query {
  collection: string;
  field: string;
  value: unknown;
  operator: string;
}
interface Listener {
  name: string;
  next: (snapshot: { docs: ReturnType<TestFirestore["snapshot"]>[] }) => void;
  error: (error: Error) => void;
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
      doc: (id: string) => {
        const ref = { id, path: `${name}/${id}` };
        return { ...ref, get: async () => this.snapshot(ref) };
      },
      onSnapshot,
      where: (field: string, operator: string, value: unknown) => ({
        collection: name,
        field,
        value,
        operator,
        onSnapshot,
        get: async () => ({
          docs: [...this.docs.entries()]
            .filter(
              ([path, data]) =>
                path.startsWith(`${name}/`) &&
                (operator === ">="
                  ? data[field] instanceof Timestamp &&
                    value instanceof Timestamp
                    ? data[field].toMillis() >= value.toMillis()
                    : String(data[field]) >= String(value)
                  : operator === "array-contains"
                    ? Array.isArray(data[field]) && data[field].includes(value)
                    : data[field] === value),
            )
            .map(([path]) => this.snapshot({ path, id: path.split("/")[1]! })),
        }),
      }),
    };
  }

  snapshot(ref: Reference) {
    const data = this.docs.get(ref.path);
    return {
      id: ref.id,
      ref: {
        ...ref,
        update: async (patch: Data) =>
          this.runTransaction(async (tx) => {
            tx.update(ref, patch);
          }),
      },
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
      create: (reference: Reference, patch: Data) => void;
      set: (reference: Reference, patch: Data) => void;
      delete: (reference: Reference) => void;
    }) => Promise<T>,
  ) {
    const writes: { reference: Reference; patch: Data; replace?: boolean }[] =
      [];
    const deletes: Reference[] = [];
    const result = await callback({
      get: async (target) => {
        this.reads++;
        if ("path" in target) return this.snapshot(target);
        const docs = [...this.docs.entries()]
          .filter(([path, data]) => {
            const field = data[target.field];
            return (
              path.startsWith(`${target.collection}/`) &&
              (target.operator === "array-contains"
                ? Array.isArray(field) && field.includes(target.value)
                : field === target.value)
            );
          })
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
      create: (reference, patch) => {
        if (this.docs.has(reference.path)) throw new Error("Existing document");
        writes.push({ reference, patch });
      },
      set: (reference, patch) => {
        writes.push({ reference, patch, replace: true });
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
    for (const { reference, patch, replace } of writes) {
      const data = replace ? {} : { ...this.docs.get(reference.path) };
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

describe("reception downtime", () => {
  const down: RadioState = {
    state: "restarting",
    error: "No supported devices found",
    lastAudioAt: null,
    lastCallAt: null,
    restartCount: 1,
  };

  test("waits two minutes, targets opt-ins, and deduplicates across restarts and completed jobs", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    store.put("users/owner", {
      approved: true,
      expoPushToken: "owner-token",
      notifyDowntime: true,
    });
    store.put("users/other", { approved: true, expoPushToken: "other-token" });
    const users = usersFixture(store);
    const monitor = new ReceptionMonitor(store.db, users);
    await monitor.check(down, now);
    await monitor.check(down, now + 119_999);
    expect(
      [...store.docs.keys()].filter((id) => id.startsWith("pushJobs/")),
    ).toHaveLength(0);
    await monitor.check(down, now + 120_000);
    const id = `pushJobs/reception-down-${now}-0`;
    expect(store.docs.get(id)).toMatchObject({
      kind: "downtime",
      recipients: [{ deviceId: "owner" }],
    });
    store.docs.delete(id);
    await new ReceptionMonitor(store.db, users).check(down, now + 180_000);
    expect(store.docs.has(id)).toBe(false);
    users.stop();
  });

  test("fresh audio without pager calls is healthy, short gaps do not alert, and recovery expires unsent alerts", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    store.put("users/owner", {
      approved: true,
      expoPushToken: "token",
      notifyDowntime: true,
    });
    const users = usersFixture(store);
    const monitor = new ReceptionMonitor(store.db, users);
    const healthy = (at: number) => ({
      ...down,
      state: "running" as const,
      error: null,
      lastAudioAt: new Date(at).toISOString(),
    });
    await monitor.check(healthy(now), now);
    await monitor.check(down, now + 30_000);
    await monitor.check(healthy(now + 60_000), now + 60_000);
    expect(
      [...store.docs.keys()].filter((id) => id.startsWith("pushJobs/")),
    ).toHaveLength(0);
    await monitor.check(down, now + 90_000);
    await monitor.check(down, now + 210_000);
    const id = `pushJobs/reception-down-${now + 90_000}-0`;
    expect(store.docs.has(id)).toBe(true);
    await monitor.check(healthy(now + 220_000), now + 220_000);
    expect(store.docs.get(id)?.expiresAt).toBe(now + 220_000);
    expect(store.docs.get("receiverHealth/main")).toMatchObject({
      outageSince: null,
      notified: false,
    });
    await monitor.check(down, now + 250_000);
    await monitor.check(down, now + 370_000);
    expect(store.docs.has(`pushJobs/reception-down-${now + 250_000}-0`)).toBe(
      true,
    );
    users.stop();
  });

  test("an ongoing outage can alert after opt-in, and a failed commit does not lose the alert", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    store.put("users/owner", { approved: true, expoPushToken: "token" });
    const users = usersFixture(store);
    const monitor = new ReceptionMonitor(store.db, users);
    await monitor.check(down, now);
    await monitor.check(down, now + 120_000);
    expect(store.docs.get("receiverHealth/main")?.notified).toBe(false);
    store.put("users/owner", {
      approved: true,
      expoPushToken: "token",
      notifyDowntime: true,
    });
    store.publishUsers();
    store.rejectWrite = (path) => path.startsWith("pushJobs/");
    await expect(monitor.check(down, now + 150_000)).rejects.toThrow(
      "Simulated Firestore write outage",
    );
    expect(store.docs.get("receiverHealth/main")?.notified).toBe(false);
    store.rejectWrite = undefined;
    await monitor.check(down, now + 180_000);
    expect(store.docs.has(`pushJobs/reception-down-${now}-0`)).toBe(true);
    users.stop();
  });
});

describe("durable Expo batches", () => {
  test("downtime recipients require a boolean opt-in, approval and a push token", () => {
    setSystemTime(now);
    const store = new TestFirestore();
    for (const [id, preference] of [
      ["enabled", true],
      ["disabled", false],
      ["string", "true"],
      ["number", 1],
    ] as const)
      store.put(`users/${id}`, {
        approved: true,
        expoPushToken: `token-${id}`,
        notifyDowntime: preference,
        showTestMessages: false,
        showVajaMessages: false,
      });
    store.put("users/missing", {
      approved: true,
      expoPushToken: "token-missing",
    });
    store.put("users/unapproved", {
      approved: false,
      expoPushToken: "token-unapproved",
      notifyDowntime: true,
    });
    store.put("users/no-token", {
      approved: true,
      notifyDowntime: true,
    });
    store.put("users/empty-token", {
      approved: true,
      expoPushToken: "",
      notifyDowntime: true,
    });
    const users = usersFixture(store);
    const downtimeRecipients = users.recipients("downtime", "TeSt VaJa");
    expect(downtimeRecipients.map((user) => user.deviceId)).toEqual([
      "enabled",
    ]);
    expect(
      users.authorized(downtimeRecipients[0]!, "downtime", "TeSt VaJa"),
    ).toBe(true);
    expect(users.recipients().map((user) => user.deviceId)).toEqual([
      "enabled",
      "disabled",
      "string",
      "number",
      "missing",
    ]);
    users.stop();
  });

  test("downtime delivery rechecks opt-in and needs no pager message", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    const ids = ["enabled", "disabled", "revoked", "rotated"];
    for (const id of ids) {
      pushFixture(store, id, {
        kind: "downtime",
        title: "Subpager reception is down",
        body: "The USB receiver is unavailable.",
      });
      store.put(`users/${id}`, {
        approved: true,
        expoPushToken: `token-${id}`,
        notifyDowntime: true,
      });
    }
    mergePushes(store, ids);
    delete store.docs.get("pushJobs/enabled")!.messageId;
    const users = usersFixture(store);
    for (const [id, changes] of [
      ["disabled", { notifyDowntime: false }],
      ["revoked", { approved: false }],
      ["rotated", { expoPushToken: "new-token" }],
    ] as const)
      store.put(`users/${id}`, {
        ...store.docs.get(`users/${id}`),
        ...changes,
      });
    store.publishUsers();
    let requests = 0;
    await new PushDelivery(
      store.db,
      async (_url, options) => {
        requests++;
        const body = JSON.parse(options.body as string);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({
          to: "token-enabled",
          title: "Subpager reception is down",
          body: "The USB receiver is unavailable.",
          channelId: "pager-alerts",
        });
        expect(body[0].data).toEqual({ kind: "downtime" });
        return Response.json({ data: [{ status: "ok", id: "ticket" }] });
      },
      undefined,
      users,
    ).run(["enabled"]);
    expect(requests).toBe(1);
    expect(recipients(store, "enabled").map((user) => user.state)).toEqual([
      "receipt",
      "failed",
      "failed",
      "failed",
    ]);
    users.stop();
  });

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
          data: { messageId: "message" },
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

  test("message preference changes suppress queued recipients and later send retries", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    const ids = ["no-test", "no-vaja", "neither", "enabled"];
    const body = "predTeStiranje in izVaJanje";
    for (const id of ids) pushFixture(store, id, { body });
    mergePushes(store, ids);
    const users = usersFixture(store);
    expect(users.recipients(undefined, body)).toHaveLength(4);
    for (const [id, preferences] of [
      ["no-test", { showTestMessages: false }],
      ["no-vaja", { showVajaMessages: false }],
      ["neither", { showTestMessages: false, showVajaMessages: false }],
      ["enabled", { showTestMessages: true, showVajaMessages: true }],
    ] as const)
      store.put(`users/${id}`, {
        ...store.docs.get(`users/${id}`),
        ...preferences,
      });
    store.publishUsers();
    let requests = 0;
    const worker = new PushDelivery(
      store.db,
      async (_url, options) => {
        requests++;
        const payload = JSON.parse(options.body as string) as { to: string }[];
        expect(payload.map((item) => item.to)).toEqual(["token-enabled"]);
        return Response.json({
          data: [
            { status: "error", details: { error: "MessageRateExceeded" } },
          ],
        });
      },
      undefined,
      users,
    );
    await worker.run(["no-test"]);
    expect(recipients(store, "no-test").map((user) => user.state)).toEqual([
      "failed",
      "failed",
      "failed",
      "pending",
    ]);
    store.put("users/enabled", {
      ...store.docs.get("users/enabled"),
      showTestMessages: false,
    });
    store.publishUsers();
    setSystemTime(now + 1000);
    await worker.run(["no-test"]);
    expect(requests).toBe(1);
    expect(
      recipients(store, "no-test").every((user) => user.state === "failed"),
    ).toBe(true);
    users.stop();
  });

  test("disconnected user cache pauses pushes instead of authorizing stale data", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    pushFixture(store);
    const users = usersFixture(store);
    store.listeners
      .find((listener) => listener.name === "users")!
      .error(new Error("User listener disconnected"));
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
    first.error(new Error("User listener disconnected"));
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
    store.listeners[1]!.error(new Error("User listener disconnected"));
    expect(() => users.recipients()).toThrow("disconnected");
    await expect(users.ready()).rejects.toThrow("stopped");
  } finally {
    users.stop();
    timeout.mockRestore();
  }
});

describe("durable location jobs", () => {
  test.each(["ŠOLI GOLO", null, "invented address"])(
    "logs the returned result %j and request duration before validation or persistence",
    async (location) => {
      setSystemTime(now);
      const store = new TestFirestore();
      locationFixture(store);
      const output = JSON.stringify({ location });
      const logged = spyOn(console, "log").mockImplementation(() => {});
      const clock = spyOn(performance, "now")
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(1350);
      try {
        await new LocationExtraction(
          store.db,
          "test-key",
          undefined,
          async () =>
            Response.json({
              status: "completed",
              output: [{ content: [{ type: "output_text", text: output }] }],
            }),
        ).run(["location"]);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged.mock.calls[0]![0]).toBe(
          `${new Date().toISOString()} INFO OpenAI location result for call location; model=gpt-6-luna; durationMs=1250; result=${output}`,
        );
        expect(store.docs.get("locationJobs/location")?.state).toBe(
          location === "invented address" ? "pending" : "ready",
        );
      } finally {
        clock.mockRestore();
        logged.mockRestore();
      }
    },
  );

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

  test("paid result survives persistence failure and enriches only the original without more inference", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    locationFixture(store);
    store.put("messages/repeat", { duplicateOf: "location", deleted: true });
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
    const logged = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(worker.run(["location"])).rejects.toThrow("write outage");
      expect(logged).toHaveBeenCalledTimes(1);
      store.rejectWrite = undefined;
      await worker.run(["location"]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(requests).toBe(1);
    expect(store.docs.get("messages/location")?.location).toBe("ŠOLI GOLO");
    expect(store.docs.get("messages/repeat")).toEqual({
      duplicateOf: "location",
      deleted: true,
    });
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

  test.each(["pending", "ready"] as const)(
    "deleted messages discard %s location jobs without inference or enrichment",
    async (state) => {
      setSystemTime(now);
      const store = new TestFirestore();
      locationFixture(store, "location", { state, result: "ŠOLI GOLO" });
      const original = {
        ...store.docs.get("messages/location"),
        deleted: true,
      };
      store.put("messages/location", original);
      let requests = 0;
      await new LocationExtraction(
        store.db,
        "test-key",
        undefined,
        async () => {
          requests++;
          return openAIResult();
        },
      ).run(["location"]);
      expect(requests).toBe(0);
      expect(store.docs.get("messages/location")).toEqual(original);
      expect(store.docs.has("locationJobs/location")).toBe(false);
    },
  );

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

const spinEvent: SpinEvent = {
  id: "472470",
  title: "Požar, eksplozija",
  description:
    "Ob 14.27 je na Golem zagorela ograja. Gasilci so požar pogasili.",
  eventAt: new Date(now - 120_000).toISOString(),
  municipality: "Ig",
};

function spinFixture(store: TestFirestore, overrides: Partial<SpinJob> = {}) {
  const job: SpinJob = {
    active: true,
    state: "pending",
    expiresAt: now + SPIN_MATCHING_HORIZON,
    nextAttempt: now,
    attempts: 0,
    failures: 0,
    leaseUntil: 0,
    ...overrides,
  };
  store.put("spinJobs/spin", { ...job });
  store.put("messages/spin", {
    content: "GORI OGRAJA PRED HIŠO - GOLO 40",
    receptions: [{ ric: 790241, time: new Date(now).toISOString() }],
    updatedAt: Timestamp.fromMillis(now),
    type: "alpha",
    duplicateOf: null,
    location: "GOLO 40",
  });
}

function spinResponse(
  incidentId: string | null,
  addressIndex: number | null = null,
  currentLinkStatus = "absent",
) {
  return Response.json({
    status: "completed",
    output: [
      {
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              incidentId,
              addressIndex,
              currentLinkStatus,
            }),
          },
        ],
      },
    ],
  });
}

describe("durable SPIN matching", () => {
  test("seeding stores only matching state and skips messages at or beyond three days", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    const message = {
      type: "alpha",
      content: "GORI OGRAJA PRED HIŠO - GOLO 40",
      duplicateOf: null,
    };
    for (const [id, age] of [
      ["recent", 60_000],
      ["boundary", SPIN_MATCHING_HORIZON],
      ["older", SPIN_MATCHING_HORIZON + 1],
    ] as const) {
      store.put(`messages/${id}`, {
        ...message,
        receptions: [
          { ric: 790242, time: new Date(now - 30 * 86_400_000).toISOString() },
          { ric: 790241, time: new Date(now - age).toISOString() },
        ],
        updatedAt: Timestamp.fromMillis(now),
      });
    }
    store.put("messages/deleted", {
      ...message,
      receptions: [{ ric: 790241, time: new Date(now).toISOString() }],
      updatedAt: Timestamp.fromMillis(now),
      deleted: true,
    });
    const worker = new SpinMatching(store.db, {
      ready: false,
      revision: "",
      events: [],
    });
    await worker.seed();
    expect(store.docs.get("spinJobs/recent")).toEqual({
      active: true,
      state: "pending",
      expiresAt: now - 60_000 + SPIN_MATCHING_HORIZON,
      nextAttempt: now,
      attempts: 0,
      failures: 0,
      leaseUntil: 0,
    });
    expect(store.docs.has("spinJobs/boundary")).toBe(false);
    expect(store.docs.has("spinJobs/older")).toBe(false);
    expect(store.docs.has("spinJobs/deleted")).toBe(false);
    await worker.seed();
    expect(store.docs.get("spinJobs/recent")?.attempts).toBe(0);
  });

  test.each(["pending", "ready"] as const)(
    "deleted messages discard %s SPIN jobs and are not reviewed or reenriched",
    async (state) => {
      setSystemTime(now);
      const store = new TestFirestore();
      spinFixture(store, { state, result: spinEvent });
      const original = { ...store.docs.get("messages/spin"), deleted: true };
      store.put("messages/spin", original);
      let requests = 0;
      const worker = new SpinMatching(
        store.db,
        { ready: true, revision: "r1", events: [spinEvent] },
        "test-key",
        undefined,
        async () => {
          requests++;
          return spinResponse(spinEvent.id);
        },
      );
      await worker.run(["spin"]);
      expect(requests).toBe(0);
      expect(store.docs.get("messages/spin")).toEqual(original);
      expect(store.docs.has("spinJobs/spin")).toBe(false);
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
      store.put("messages/spin", { ...original, spinEventId: spinEvent.id });
      await worker.review(spinEvent.id);
      expect(store.docs.has("spinJobs/spin")).toBe(false);
      expect(await unlinkSpinEvent(store.db, "spin")).toBe(false);
    },
  );

  test("unchanged waiting revisions skip inference and a changed report retries a null decision", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    const catalog = { ready: true, revision: "r1", events: [spinEvent] };
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      catalog,
      "benchmark-key",
      undefined,
      async (_url, options) => {
        const body = JSON.parse(options!.body as string) as {
          model: string;
          store: boolean;
          input: { content: string }[];
          text: {
            format: {
              schema: {
                properties: { incidentId: { enum: (string | null)[] } };
              };
            };
          };
        };
        expect(body.model).toBe("gpt-6-luna");
        expect(body.store).toBe(false);
        expect(body.text.format.schema.properties.incidentId.enum).toEqual([
          spinEvent.id,
          null,
        ]);
        expect(JSON.parse(body.input[1]!.content).pager).toEqual({
          message: "GORI OGRAJA PRED HIŠO - GOLO 40",
          receivedAt: new Date(now).toISOString(),
          location: "GOLO 40",
        });
        requests++;
        return spinResponse(null);
      },
    );
    await worker.run(["spin"]);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      checkedRevision: "r1",
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
    for (const field of ["messageId", "content", "receivedAt"])
      expect(store.docs.get("spinJobs/spin")).not.toHaveProperty(field);
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(false);
    await worker.run(["spin"]);
    expect(requests).toBe(1);
    catalog.revision = "r2";
    catalog.events = [
      { ...spinEvent, description: "A revised public report." },
    ];
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(true);
    await worker.run(["spin"]);
    expect(requests).toBe(2);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      checkedRevision: "r2",
    });
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
  });

  test.each(["ready", "waiting"])(
    "paid %s results survive failed writes without another API call",
    async (state) => {
      setSystemTime(now);
      const store = new TestFirestore();
      spinFixture(store);
      store.put("messages/repeat", {
        duplicateOf: "spin",
        deleted: true,
        content: "Repeated original pager",
      });
      const catalog = { ready: true, revision: "r1", events: [spinEvent] };
      let requests = 0;
      const worker = new SpinMatching(
        store.db,
        catalog,
        "benchmark-key",
        undefined,
        async () => {
          requests++;
          return spinResponse(state === "ready" ? spinEvent.id : null);
        },
      );
      store.rejectWrite = (_path, patch) => patch.state === state;
      await expect(worker.run(["spin"])).rejects.toThrow("write outage");
      expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
      store.rejectWrite = undefined;
      await worker.run(["spin"]);
      expect(requests).toBe(1);
      if (state === "ready") {
        expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
        expect(store.docs.get("messages/repeat")?.spinEventId).toBeUndefined();
        expect(store.docs.has("spinJobs/spin")).toBe(false);
      } else {
        expect(store.docs.get("spinJobs/spin")).toMatchObject({
          state: "waiting",
          checkedRevision: "r1",
        });
        expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
      }
    },
  );

  test("a persisted ready result publishes after restart during a quota pause and leaves archived repeats unchanged", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, {
      state: "ready",
      result: spinEvent,
      checkedRevision: "r1",
    });
    store.put("messages/repeat", {
      duplicateOf: "spin",
      deleted: true,
      content: "Repeated original pager",
    });
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      { ready: false, revision: "", events: [] },
      "benchmark-key",
      undefined,
      async () => {
        requests++;
        return spinResponse(null);
      },
    );
    worker.pausedUntil = now + 3_600_000;
    store.rejectWrite = (path, patch) =>
      path === "messages/spin" && patch.spinEventId === spinEvent.id;
    await expect(worker.run(["spin"])).rejects.toThrow("write outage");
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.get("messages/repeat")?.spinEventId).toBeUndefined();
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    expect(store.docs.has("spinJobs/spin")).toBe(true);
    store.rejectWrite = undefined;
    setSystemTime(now + SPIN_MATCHING_HORIZON + 60_000);
    await worker.run(["spin"]);
    expect(requests).toBe(0);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.get("messages/spin")?.updatedAt).toEqual(
      FieldValue.serverTimestamp(),
    );
    expect(store.docs.get("messages/repeat")).toEqual({
      duplicateOf: "spin",
      deleted: true,
      content: "Repeated original pager",
    });
    expect(store.docs.get("messages/spin")?.content).toBe(
      "GORI OGRAJA PRED HIŠO - GOLO 40",
    );
    expect(store.docs.get("messages/repeat")?.content).toBe(
      "Repeated original pager",
    );
    expect(store.docs.has("spinJobs/spin")).toBe(false);
    expect(store.docs.get(`spinEvents/${spinEvent.id}`)).toEqual({
      ...spinEvent,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  test.each([true, false])(
    "a new paging batch publishes its paid result before reviewing the latest reception: matched=%s",
    async (matched) => {
      const latest = now + 4 * 60_000;
      setSystemTime(latest);
      const store = new TestFirestore();
      spinFixture(store, {
        state: "ready",
        ...(matched
          ? { result: spinEvent }
          : { reviewEventId: spinEvent.id, reviewStatus: "invalid" }),
        checkedRevision: "r1",
        expiresAt: latest + SPIN_MATCHING_HORIZON,
        reviewAfterPublish: true,
      });
      store.put("messages/spin", {
        ...store.docs.get("messages/spin"),
        ...(!matched ? { spinEventId: spinEvent.id } : {}),
        receptions: [
          { ric: 790241, time: new Date(now).toISOString() },
          { ric: 790242, time: new Date(latest).toISOString() },
        ],
      });
      if (!matched) store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
      const latestEvent = {
        ...spinEvent,
        id: "472471",
        eventAt: new Date(latest - 120_000).toISOString(),
      };
      let requests = 0;
      const worker = new SpinMatching(
        store.db,
        { ready: true, revision: "r1", events: [spinEvent, latestEvent] },
        "test-key",
        undefined,
        async (_url, options) => {
          const input = JSON.parse(
            JSON.parse(options.body as string).input[1].content,
          );
          expect(input.pager.receivedAt).toBe(new Date(latest).toISOString());
          expect(input.currentLinkId).toBe(matched ? spinEvent.id : null);
          requests++;
          return spinResponse(
            latestEvent.id,
            null,
            matched ? "invalid" : "absent",
          );
        },
      );
      await worker.run(["spin"]);
      expect(requests).toBe(0);
      expect(store.docs.get("messages/spin")?.spinEventId).toBe(
        matched ? spinEvent.id : undefined,
      );
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(matched);
      expect(store.docs.get("spinJobs/spin")).toMatchObject({
        state: "pending",
        expiresAt: latest + SPIN_MATCHING_HORIZON,
        leaseUntil: 0,
        nextAttempt: latest,
      });
      expect(store.docs.get("spinJobs/spin")?.reviewEventId).toBe(
        matched ? spinEvent.id : undefined,
      );
      for (const field of [
        "result",
        "reviewStatus",
        "checkedRevision",
        "reviewAfterPublish",
      ])
        expect(store.docs.get("spinJobs/spin")).not.toHaveProperty(field);
      await worker.run(["spin"]);
      expect(requests).toBe(1);
      await worker.run(["spin"]);
      expect(requests).toBe(1);
      expect(store.docs.get("messages/spin")?.spinEventId).toBe(latestEvent.id);
      expect(store.docs.has("spinJobs/spin")).toBe(false);
    },
  );

  test("retrying a paid result with a lost acknowledgement retains a newer paging review", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r1", events: [spinEvent] },
      "test-key",
      undefined,
      async () => {
        requests++;
        store.loseAcknowledgement = true;
        return spinResponse(spinEvent.id);
      },
    );
    await expect(worker.run(["spin"])).rejects.toThrow("acknowledgement lost");
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "ready",
      result: spinEvent,
    });
    store.loseAcknowledgement = false;
    const latest = now + 4 * 60_000;
    setSystemTime(latest);
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      receptions: [
        { ric: 790241, time: new Date(now).toISOString() },
        { ric: 790242, time: new Date(latest).toISOString() },
      ],
    });
    store.put("spinJobs/spin", {
      ...store.docs.get("spinJobs/spin"),
      expiresAt: latest + SPIN_MATCHING_HORIZON,
      reviewAfterPublish: true,
    });
    await worker.run(["spin"]);
    expect(requests).toBe(1);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "pending",
      reviewEventId: spinEvent.id,
      expiresAt: latest + SPIN_MATCHING_HORIZON,
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty(
      "reviewAfterPublish",
    );
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
  });

  test("a positive decision retains its public report and creates it only when publishing a pager link", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    const candidate = { ...spinEvent, nextDetailAt: now, rssRevision: "rss" };
    const catalog = { ready: true, revision: "r1", events: [candidate] };
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      catalog,
      "benchmark-key",
      undefined,
      async () => {
        requests++;
        return spinResponse(spinEvent.id);
      },
    );
    await worker.run(["spin"]);
    expect(store.docs.get("spinJobs/spin")?.result).toEqual(spinEvent);
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    catalog.events = [];
    await new SpinMatching(store.db, catalog).run(["spin"]);
    expect(requests).toBe(1);
    expect(store.docs.get(`spinEvents/${spinEvent.id}`)).toEqual({
      ...spinEvent,
      updatedAt: FieldValue.serverTimestamp(),
    });
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test("publishing another pager link preserves an existing newer report", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { state: "ready", result: spinEvent });
    const newer = { ...spinEvent, description: "Updated public report." };
    store.put(`spinEvents/${spinEvent.id}`, newer);
    await new SpinMatching(store.db, {
      ready: false,
      revision: "",
      events: [],
    }).run(["spin"]);
    expect(store.docs.get(`spinEvents/${spinEvent.id}`)).toEqual(newer);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
  });

  test.each(["missing", "linked"])(
    "a %s pager never creates an orphan report from a persisted ready result",
    async (state) => {
      setSystemTime(now);
      const store = new TestFirestore();
      spinFixture(store, { state: "ready", result: spinEvent });
      if (state === "missing") store.docs.delete("messages/spin");
      else
        store.put("messages/spin", {
          ...store.docs.get("messages/spin"),
          spinEventId: "another-event",
        });
      await new SpinMatching(store.db, {
        ready: false,
        revision: "",
        events: [],
      }).run(["spin"]);
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
      expect(store.docs.has("spinJobs/spin")).toBe(false);
    },
  );

  test("unmatched jobs expire after three days without inference during a quota pause before the feed is ready", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { nextAttempt: now + 4 * 86_400_000 });
    setSystemTime(now + SPIN_MATCHING_HORIZON);
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      { ready: false, revision: "", events: [] },
      "benchmark-key",
      undefined,
      async () => {
        requests++;
        return spinResponse(null);
      },
    );
    worker.pausedUntil = now + 4 * 86_400_000;
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(true);
    await worker.run(["spin"]);
    expect(requests).toBe(0);
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test("a report revision before provisional publication requires a fresh decision before linking", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      receptions: [
        { ric: 790241, time: new Date(now - 30 * 86_400_000).toISOString() },
        { ric: 790242, time: new Date(now - 60_000).toISOString() },
        { ric: 790241, time: new Date(now).toISOString() },
      ],
    });
    store.put("ricUnits/790241", { unitName: "Gasilska brigada Ljubljana" });
    store.put("ricUnits/790242", { unitName: "PGD Golo" });
    store.put("messages/repeat", { duplicateOf: "spin" });
    const partial = {
      ...spinEvent,
      description: "Ig",
      latitude: 45.909,
      longitude: 14.549,
    };
    const catalog = { ready: true, revision: "r1", events: [partial] };
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      catalog,
      "test-key",
      undefined,
      async (_url, options) => {
        const input = JSON.parse(
          JSON.parse(options.body as string).input[1].content,
        );
        expect(input.pager.unitName).toBe(
          "Gasilska brigada Ljubljana, PGD Golo",
        );
        expect(input.pager.receivedAt).toBe(new Date(now).toISOString());
        requests++;
        return requests === 1
          ? spinResponse(partial.id, 0)
          : spinResponse(spinEvent.id);
      },
      async () => [
        { address: "Golo, 40, Ig", latitude: 45.909, longitude: 14.549 },
      ],
    );
    await worker.run(["spin"]);
    expect(store.docs.has(`spinEvents/${partial.id}`)).toBe(false);
    store.put("spinJobs/spin", {
      ...store.docs.get("spinJobs/spin"),
      reviewAfterPublish: true,
    });
    catalog.revision = "r2";
    catalog.events = [{ ...partial, description: spinEvent.description }];
    await worker.run(["spin"]);
    for (const id of ["spin", "repeat"])
      expect(store.docs.get(`messages/${id}`)?.spinEventId).toBeUndefined();
    expect(store.docs.has(`spinEvents/${partial.id}`)).toBe(false);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      checkedRevision: "r1",
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("reviewEventId");
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(true);
    await worker.run(["spin"]);
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty(
      "reviewAfterPublish",
    );
    await worker.run(["spin"]);
    expect(requests).toBe(2);
    expect(store.docs.get("messages/spin")?.spinMatchStatus).toBe("confirmed");
    expect(store.docs.get("messages/repeat")?.spinMatchStatus).toBeUndefined();
    expect(store.docs.get(`spinEvents/${partial.id}`)?.description).toBe(
      spinEvent.description,
    );
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test.each([false, true])(
    "an invalid reviewed link rematches atomically and preserves a shared report: %s",
    async (shared) => {
      setSystemTime(now);
      const store = new TestFirestore();
      const oldId = "472568";
      spinFixture(store, { reviewEventId: oldId });
      store.put("messages/spin", {
        ...store.docs.get("messages/spin"),
        spinEventId: oldId,
        spinMatchStatus: "provisional",
      });
      store.put("messages/repeat", {
        duplicateOf: "spin",
        deleted: true,
        spinEventId: oldId,
      });
      store.put("messages/deleted-unit", { deleted: true, spinEventId: oldId });
      const old = {
        ...spinEvent,
        id: oldId,
        description: "Unrelated fire in another town",
      };
      store.put(`spinEvents/${oldId}`, old);
      if (shared) store.put("messages/another-unit", { spinEventId: oldId });
      const worker = new SpinMatching(
        store.db,
        { ready: true, revision: "r2", events: [old, spinEvent] },
        "test-key",
        undefined,
        async () => spinResponse(spinEvent.id, null, "invalid"),
      );
      await worker.run(["spin"]);
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
      await worker.run(["spin"]);
      expect(store.docs.get("messages/spin")).toMatchObject({
        spinEventId: spinEvent.id,
        spinMatchStatus: "confirmed",
        spinRejectedEventIds: [oldId],
      });
      expect(store.docs.get("messages/repeat")).toEqual({
        duplicateOf: "spin",
        deleted: true,
        spinEventId: oldId,
      });
      expect(store.docs.has(`spinEvents/${oldId}`)).toBe(shared);
      if (shared)
        expect(store.docs.get("messages/another-unit")?.spinEventId).toBe(
          oldId,
        );
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(true);
      expect(store.docs.has("spinJobs/spin")).toBe(false);
    },
  );

  test("a missing source preserves a provisional link and does not create a replacement", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    const missingId = "472584";
    spinFixture(store, { reviewEventId: missingId });
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: missingId,
      spinMatchStatus: "provisional",
    });
    store.put(`spinEvents/${missingId}`, { ...spinEvent, id: missingId });
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r2", events: [spinEvent] },
      "test-key",
      undefined,
      async () => spinResponse(null, null, "invalid"),
    );
    await worker.run(["spin"]);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(missingId);
    expect(store.docs.has(`spinEvents/${missingId}`)).toBe(true);
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      reviewStatus: "uncertain",
    });
  });

  test("manual unlinking an event rejects its original pair, preserves other units and excludes the rejected incident from rematching", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { state: "ready", result: spinEvent });
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: spinEvent.id,
      spinMatchStatus: "confirmed",
    });
    store.put("messages/repeat", {
      duplicateOf: "spin",
      deleted: true,
      spinEventId: spinEvent.id,
    });
    store.put("messages/another-unit", { spinEventId: spinEvent.id });
    store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
    expect(await unlinkSpinEvent(store.db, "repeat")).toBe(false);
    expect(await unlinkSpinEvent(store.db, "spin")).toBe(true);
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.get("messages/spin")?.spinMatchStatus).toBeUndefined();
    expect(store.docs.get("messages/spin")?.spinRejectedEventIds).toEqual([
      spinEvent.id,
    ]);
    expect(store.docs.get("messages/repeat")).toEqual({
      duplicateOf: "spin",
      deleted: true,
      spinEventId: spinEvent.id,
    });
    expect(store.docs.get("messages/another-unit")?.spinEventId).toBe(
      spinEvent.id,
    );
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(true);
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
    const alternative = { ...spinEvent, id: "472222" };
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r2", events: [spinEvent, alternative] },
      "test-key",
      undefined,
      async (_url, options) => {
        const input = JSON.parse(
          JSON.parse(options.body as string).input[1].content,
        );
        expect(input.currentLinkId).toBeNull();
        expect(input.incidents.map((event: SpinEvent) => event.id)).toEqual([
          alternative.id,
        ]);
        return spinResponse(alternative.id);
      },
    );
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(alternative.id);
    expect(store.docs.get("messages/repeat")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(true);
  });

  test("invalid evidence without a replacement unlinks the original, ignores archived links and retains a rematch job", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { reviewEventId: spinEvent.id });
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: spinEvent.id,
    });
    store.put("messages/repeat", {
      duplicateOf: "spin",
      deleted: true,
      spinEventId: spinEvent.id,
    });
    store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r2", events: [spinEvent] },
      "test-key",
      undefined,
      async () => spinResponse(null, null, "invalid"),
    );
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.get("messages/spin")?.spinRejectedEventIds).toEqual([
      spinEvent.id,
    ]);
    expect(store.docs.get("messages/repeat")).toEqual({
      duplicateOf: "spin",
      deleted: true,
      spinEventId: spinEvent.id,
    });
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "pending",
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("reviewEventId");
  });

  test("location publication wakes matching and invalidates an in-flight decision made without its address", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    const message = { ...store.docs.get("messages/spin") };
    delete message.location;
    locationFixture(store, "spin", {
      state: "ready",
      content: message.content as string,
      result: "GOLO 40",
    });
    store.put("messages/spin", message);
    const partial = {
      ...spinEvent,
      description: "Ig",
      latitude: 45.909,
      longitude: 14.549,
    };
    let started!: () => void;
    let respond!: (response: Response) => void;
    const startedRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r1", events: [partial] },
      "test-key",
      undefined,
      async () => {
        requests++;
        if (requests === 1) {
          started();
          return response;
        }
        return spinResponse(partial.id, 0);
      },
      async () => [
        { address: "Golo, 40, Ig", latitude: 45.909, longitude: 14.549 },
      ],
    );
    const inFlight = worker.run(["spin"]);
    await startedRequest;
    await new LocationExtraction(store.db).run(["spin"]);
    expect(store.docs.get("messages/spin")?.location).toBe("GOLO 40");
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "pending",
      attempts: 2,
      leaseUntil: 0,
    });
    respond(spinResponse(null));
    await inFlight;
    expect(store.docs.get("spinJobs/spin")?.state).toBe("pending");
    await worker.run(["spin"]);
    expect(requests).toBe(2);
    expect(store.docs.get("spinJobs/spin")?.result).toEqual(partial);
  });

  test("a source revision during inference prevents publication of the stale full result", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    const catalog = { ready: true, revision: "r1", events: [spinEvent] };
    const worker = new SpinMatching(
      store.db,
      catalog,
      "test-key",
      undefined,
      async () => {
        catalog.revision = "r2";
        catalog.events = [
          { ...spinEvent, description: "Revised full narrative" },
        ];
        return spinResponse(spinEvent.id);
      },
    );
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      checkedRevision: "r1",
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(true);
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    expect(store.docs.get("messages/spin")?.spinMatchStatus).toBe("confirmed");
    expect(store.docs.get(`spinEvents/${spinEvent.id}`)?.description).toBe(
      "Revised full narrative",
    );
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test("a stale invalid-link decision preserves its existing link until fresh review", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { reviewEventId: spinEvent.id });
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: spinEvent.id,
      spinMatchStatus: "confirmed",
    });
    store.put("messages/repeat", {
      duplicateOf: "spin",
      deleted: true,
      spinEventId: spinEvent.id,
    });
    store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
    const catalog = { ready: true, revision: "r1", events: [spinEvent] };
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      catalog,
      "test-key",
      undefined,
      async () => {
        requests++;
        if (requests === 1) {
          catalog.revision = "r2";
          return spinResponse(null, null, "invalid");
        }
        return spinResponse(spinEvent.id, null, "valid");
      },
    );
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    for (const id of ["spin", "repeat"]) {
      expect(store.docs.get(`messages/${id}`)?.spinEventId).toBe(spinEvent.id);
      expect(store.docs.get(`messages/${id}`)).not.toHaveProperty(
        "spinRejectedEventIds",
      );
    }
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(true);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      reviewEventId: spinEvent.id,
      checkedRevision: "r1",
      leaseUntil: 0,
    });
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("result");
    expect(store.docs.get("spinJobs/spin")).not.toHaveProperty("reviewStatus");
    await worker.run(["spin"]);
    await worker.run(["spin"]);
    expect(requests).toBe(2);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test("an expired paid result remains publishable despite a newer ready catalogue", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, {
      state: "ready",
      result: spinEvent,
      checkedRevision: "r1",
    });
    setSystemTime(now + SPIN_MATCHING_HORIZON);
    const worker = new SpinMatching(store.db, {
      ready: true,
      revision: "r2",
      events: [spinEvent],
    });
    await worker.run(["spin"]);
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.has("spinJobs/spin")).toBe(false);
  });

  test("retrying a report update retains an unprocessed review of the changed catalog", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    store.docs.delete("spinJobs/spin");
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: spinEvent.id,
      spinMatchStatus: "confirmed",
    });
    store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
    const temporary = await mkdtemp(join(tmpdir(), "subpager-spin-review-"));
    const cachePath = join(temporary, "candidates.json");
    const feedUrl = "https://spin3.sos112.si/javno/ODApi/184";
    let description = spinEvent.description;
    let worker: SpinMatching;
    const sync = new SpinSync(
      store.db,
      feedUrl,
      () => {},
      cachePath,
      (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/odObmocje"))
          return Response.json({ value: [{ items: [{ naziv: "Ig" }] }] });
        if (url === feedUrl)
          return new Response(
            `<rss><channel><item><title>${spinEvent.title}</title><guid>https://spin3.sos112.si/javno/zemljevid/${spinEvent.id}</guid><description>${description}</description><pubDate>${new Date(spinEvent.eventAt).toUTCString()}</pubDate></item></channel></rss>`,
          );
        return Response.json({ value: { obcinaNaziv: "Ig" } });
      }) as typeof fetch,
      (id) => worker.review(id),
    );
    let requests = 0;
    worker = new SpinMatching(
      store.db,
      sync,
      "test-key",
      undefined,
      async () => {
        requests++;
        return spinResponse(null, null, "invalid");
      },
    );
    try {
      await sync.run();
      const revision = sync.revision;
      description = "A different incident.";
      store.rejectWrite = (path) => path === `spinEvents/${spinEvent.id}`;
      await expect(sync.run()).rejects.toThrow(
        "Simulated Firestore write outage",
      );
      expect(sync.revision).toBe(revision);
      expect(sync.events[0]?.description).toBe(spinEvent.description);
      expect(
        JSON.parse(await readFile(cachePath, "utf8"))[0]?.description,
      ).toBe(description);
      expect(store.docs.get("spinJobs/spin")?.checkedRevision).toBe(revision);
      expect(
        worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
      ).toBe(false);
      store.rejectWrite = undefined;
      await sync.run();
      expect(sync.revision).not.toBe(revision);
      expect(store.docs.get("spinJobs/spin")?.checkedRevision).toBe(revision);
      expect(
        worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
      ).toBe(true);
      await worker.run(["spin"]);
      await worker.run(["spin"]);
      expect(requests).toBe(1);
      expect(store.docs.get("messages/spin")?.spinEventId).toBeUndefined();
      expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(false);
    } finally {
      await sync.stop();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("a report review invalidates an in-flight removal decision and waits for the updated catalog", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store, { reviewEventId: spinEvent.id });
    store.put("messages/spin", {
      ...store.docs.get("messages/spin"),
      spinEventId: spinEvent.id,
    });
    store.put(`spinEvents/${spinEvent.id}`, { ...spinEvent });
    const catalog = { ready: true, revision: "r1", events: [spinEvent] };
    let started!: () => void;
    let respond!: (response: Response) => void;
    const startedRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const worker = new SpinMatching(
      store.db,
      catalog,
      "test-key",
      undefined,
      async () => {
        started();
        return response;
      },
    );
    const inFlight = worker.run(["spin"]);
    await startedRequest;
    await worker.review(spinEvent.id);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      state: "waiting",
      attempts: 2,
      leaseUntil: 0,
      checkedRevision: "r1",
    });
    catalog.revision = "r2";
    respond(spinResponse(null, null, "invalid"));
    await inFlight;
    expect(store.docs.get("messages/spin")?.spinEventId).toBe(spinEvent.id);
    expect(store.docs.has(`spinEvents/${spinEvent.id}`)).toBe(true);
    expect(store.docs.get("spinJobs/spin")?.state).toBe("waiting");
    expect(
      worker.canRun(store.docs.get("spinJobs/spin") as unknown as SpinJob),
    ).toBe(true);
  });

  test("quota pauses persist their next attempt without consuming the ordinary failure budget", async () => {
    setSystemTime(now);
    const store = new TestFirestore();
    spinFixture(store);
    let requests = 0;
    const worker = new SpinMatching(
      store.db,
      { ready: true, revision: "r1", events: [spinEvent] },
      "benchmark-key",
      undefined,
      async () => {
        requests++;
        return new Response("", { status: 429 });
      },
    );
    await worker.run(["spin"]);
    expect(worker.pausedUntil).toBe(now + 3_600_000);
    expect(store.docs.get("spinJobs/spin")).toMatchObject({
      active: true,
      state: "pending",
      failures: 0,
      nextAttempt: now + 3_600_000,
      leaseUntil: 0,
      lastError: "OpenAI HTTP 429",
    });
    await worker.run(["spin"]);
    expect(requests).toBe(1);
  });
});

test("an idle listener logs recovery on its first reconnected snapshot without repeating connection logs", async () => {
  const store = new TestFirestore();
  let reconnect: (() => void) | undefined;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    expect(delay).toBe(30_000);
    reconnect = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const info = spyOn(console, "log").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const run = spyOn(PushDelivery.prototype, "run").mockResolvedValue();
  const worker = new FirestoreJobsProcessor(store.db);
  try {
    worker.start();
    const listener = store.listeners.find(
      (candidate) => candidate.name === "pushJobs",
    )!;
    listener.error(new Error("Index is not ready"));
    expect(errors.mock.calls[0]![0]).toContain("Index is not ready");
    expect(info).not.toHaveBeenCalled();
    reconnect!();
    const connected = store.listeners.at(-1)!;
    expect(connected.name).toBe("pushJobs");
    connected.next({ docs: [] });
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining("pushJobs recovered"),
      expect.stringContaining("pushJobs listener connected"),
    ]);
    connected.next({ docs: [] });
    connected.next({ docs: [] });
    expect(info).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  } finally {
    await worker.stop();
    run.mockRestore();
    errors.mockRestore();
    info.mockRestore();
    timeout.mockRestore();
  }
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
    listener.error(new Error("Job listener disconnected"));
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
