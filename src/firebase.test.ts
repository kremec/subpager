import { expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config";
import { FirebaseClient, FirebaseWorker } from "./firebase";
import { PushWorker } from "./delivery";
import { Store } from "./store";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const account = {
  project_id: "subpager-test",
  client_email: "receiver@subpager-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const page = () => ({
  receivedAt: new Date().toISOString(),
  ric: 123456,
  function: 3,
  type: "alpha" as const,
  content: "TEST ČŠŽ",
});

test("removing obsolete filters and sync tables preserves history, recordings and push jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-append-only-"));
  const path = join(directory, "history.sqlite");
  let store: Store | undefined = new Store(path, true);
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    const first = store.save(page(), 0, 300);
    const second = store.save(page(), 0, 300);
    const pending = store.save({ ...page(), content: "Not uploaded" }, 0, 300);
    store.saveRecording(new Uint8Array([1, 2, 3]), [first]);
    const history = store.list({ limit: 100, includeRepeats: true }).messages;
    const jobs = store.dueJobs("pending", Date.now());
    const recording = store.getRecording(first.id);
    store.db.exec(`
      ALTER TABLE devices ADD COLUMN rics TEXT NOT NULL DEFAULT '[]';
      UPDATE devices SET rics = '[999999]';
      CREATE TABLE firebase_sync (project_id TEXT PRIMARY KEY, last_message_id INTEGER NOT NULL);
      CREATE TABLE message_revisions (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL
      );
      INSERT INTO message_revisions SELECT id, 1 FROM messages;
      CREATE TABLE firebase_message_revisions (
        project_id TEXT NOT NULL,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        PRIMARY KEY (project_id, message_id)
      );
      CREATE TRIGGER message_revision_insert AFTER INSERT ON messages
      BEGIN INSERT INTO message_revisions VALUES (new.id, 1); END;
      CREATE TRIGGER message_revision_update AFTER UPDATE OF content ON messages
      BEGIN UPDATE message_revisions SET revision = revision + 1 WHERE message_id = new.id; END;
    `);
    store.db
      .query("INSERT INTO firebase_message_revisions VALUES (?, ?, 1)")
      .run(account.project_id, first.id);
    store.db
      .query("INSERT INTO firebase_sync VALUES (?, ?)")
      .run(account.project_id, second.id);
    store.close();
    store = undefined;
    store = new Store(path, true);
    expect(
      store.db
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('firebase_sync', 'message_revisions', 'firebase_message_revisions', 'message_revision_insert', 'message_revision_update')",
        )
        .all(),
    ).toEqual([]);
    expect(
      store.db
        .query<{ name: string }, []>("PRAGMA table_info(devices)")
        .all()
        .some(({ name }) => name === "rics"),
    ).toBe(false);
    expect(store.list({ limit: 100, includeRepeats: true }).messages).toEqual(
      history,
    );
    expect(store.getRecording(first.id)).toEqual(recording);
    expect(store.dueJobs("pending", Date.now())).toEqual(jobs);
    expect(store.firebaseMessages(second.id)).toEqual([pending]);
    expect(store.firebaseMessages(0)).toHaveLength(3);
    expect(store.firebaseMessages(pending.id)).toEqual([]);
    const next = store.save({ ...page(), content: "Next call" }, 0, 300);
    expect(next.id).toBe(pending.id + 1);
    expect(store.firebaseMessages(pending.id)).toEqual([next]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Firestore errors include the operation and API reason, with a fallback for non-JSON responses", async () => {
  let response = Response.json(
    { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } },
    { status: 429 },
  );
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      return response;
    },
  );
  await expect(client.list("members")).rejects.toThrow(
    "Firestore HTTP 429 (GET /members): Quota exceeded.",
  );
  response = new Response("Service unavailable", { status: 503 });
  await expect(client.get("messages", "1")).rejects.toThrow(
    "Firestore HTTP 503 (GET /messages/1)",
  );
});

function document(id: string, approved = true, rics: unknown[] = []) {
  return {
    name: `projects/subpager-test/databases/(default)/documents/devices/${id}`,
    updateTime: "2026-10-08T10:00:00.123456Z",
    fields: {
      approved: { booleanValue: approved },
      expoPushToken: { stringValue: `ExpoPushToken[${id}]` },
      rics: {
        arrayValue: {
          values: rics.map((ric) =>
            typeof ric === "number"
              ? { integerValue: String(ric) }
              : { stringValue: ric },
          ),
        },
      },
    },
  };
}

function cursorResponse(id = 0) {
  return Response.json(
    id
      ? [{ document: { fields: { id: { integerValue: String(id) } } } }]
      : [{ readTime: "2026-10-08T10:00:00Z" }],
  );
}

test("Firestore cursor uses the numeric message ID and rejects malformed responses", async () => {
  let body: object = [{ readTime: "2026-10-08T10:00:00Z" }];
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      expect(url).toEndWith(":runQuery");
      expect(JSON.parse(options.body as string)).toMatchObject({
        structuredQuery: {
          from: [{ collectionId: "messages" }],
          orderBy: [{ field: { fieldPath: "id" }, direction: "DESCENDING" }],
          limit: 1,
        },
      });
      return Response.json(body);
    },
  );
  expect(await client.latestMessageId()).toBe(0);
  body = [
    {
      document: {
        name: "projects/subpager-test/databases/(default)/documents/messages/14",
        fields: { id: { integerValue: "14" } },
      },
    },
    { readTime: "2026-10-08T10:00:00Z" },
  ];
  expect(await client.latestMessageId()).toBe(14);
  for (const malformed of [
    {},
    [{}],
    [{ document: null }],
    [{ document: { fields: {} } }],
    ...["0", "-1", "1e2", "1.5", "9007199254740992"].map((id) => [
      { document: { fields: { id: { integerValue: id } } } },
    ]),
  ]) {
    body = malformed;
    await expect(client.latestMessageId()).rejects.toThrow(
      "Invalid Firestore message cursor response",
    );
  }
});

test("startup query failures pause uploads and push authorization until the remote cursor is known", async () => {
  const store = new Store(":memory:", true);
  let fail = true;
  let queries = 0;
  let uploads = 0;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) {
        queries++;
        return fail ? new Response(null, { status: 503 }) : cursorResponse();
      }
      if (url.endsWith(":commit")) {
        uploads++;
        return Response.json({});
      }
      if (url.includes("/members/") || url.includes("/devices/"))
        return Response.json(document("friend"));
      return Response.json({ documents: [document("friend")] });
    },
  );
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.save(page(), 0, 300);
    const job = store.dueJobs("pending", Date.now())[0]!;
    const worker = new FirebaseWorker(store, client);
    const now = Date.now() + 1000;
    await expect(worker.authorize(job)).rejects.toThrow(
      "Message upload is pending",
    );
    await expect(worker.tick(now)).rejects.toThrow(
      "Firestore HTTP 503 (POST :runQuery)",
    );
    expect(uploads).toBe(0);
    await expect(worker.authorize(job)).rejects.toThrow(
      "Message upload is pending",
    );
    await worker.tick(now + 14999);
    expect(queries).toBe(1);
    fail = false;
    await worker.tick(now + 15000);
    expect(queries).toBe(2);
    expect(uploads).toBe(1);
    expect(await worker.authorize(job)).toBe(true);
    await worker.tick(now + 16000);
    expect(queries).toBe(2);
    expect(uploads).toBe(1);
  } finally {
    store.close();
  }
});

test("restart resumes from Firestore even when the previous successful upload response was lost", async () => {
  const store = new Store(":memory:", true);
  let remoteId = 1;
  let queries = 0;
  const uploads: number[][] = [];
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) {
        queries++;
        return cursorResponse(remoteId);
      }
      if (url.endsWith(":commit")) {
        const body = JSON.parse(options.body as string) as {
          writes: { update: { fields: { id: { integerValue: string } } } }[];
        };
        const ids = body.writes.map((write) =>
          Number(write.update.fields.id.integerValue),
        );
        uploads.push(ids);
        remoteId = ids.at(-1)!;
        throw new Error("Upload response lost");
      }
      return Response.json({ documents: [] });
    },
  );
  try {
    for (let i = 0; i < 3; i++) store.save(page(), 0, 300);
    const first = new FirebaseWorker(store, client);
    await expect(first.tick()).rejects.toThrow("Upload response lost");
    expect(uploads).toEqual([[2, 3]]);
    const restarted = new FirebaseWorker(store, client);
    await restarted.tick();
    await restarted.tick();
    expect(queries).toBe(2);
    expect(uploads).toEqual([[2, 3]]);
    expect(restarted.lastError).toBeNull();
  } finally {
    store.close();
  }
});

test("concurrent authorization shares OAuth and document requests without caching stale approvals", async () => {
  let oauth = 0;
  let reads = 0;
  let fail = true;
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2")) {
        oauth++;
        await release;
        return Response.json({ access_token: "test", expires_in: 3600 });
      }
      reads++;
      if (fail) return new Response(null, { status: 503 });
      return Response.json(document("friend", false));
    },
  );
  const store = new Store(":memory:", true);
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.save(page(), 0, 300);
    const job = store.dueJobs("pending", Date.now())[0]!;
    const attempts = Array.from({ length: 20 }, () => client.authorize(job));
    resolve();
    const failures = await Promise.allSettled(attempts);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(oauth).toBe(1);
    expect(reads).toBe(2);
    fail = false;
    expect(await client.authorize(job)).toBe(false);
    expect(reads).toBe(4);
    expect(oauth).toBe(1);
  } finally {
    store.close();
  }
});

test("quota failures back off to five minutes, preserve the in-memory cursor, and reset after recovery", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const store = new Store(":memory:", true);
  let fail = true;
  let commits = 0;
  let polls = 0;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.endsWith(":commit")) {
        commits++;
        return fail
          ? Response.json(
              { error: { message: "Quota exceeded." } },
              { status: 429 },
            )
          : Response.json({});
      }
      polls++;
      return Response.json({ documents: [] });
    },
  );
  try {
    store.save(page(), 0, 300);
    const worker = new FirebaseWorker(store, client);
    await expect(worker.tick()).rejects.toThrow("Quota exceeded.");
    let attempts = 1;
    for (const delay of [15000, 30000, 60000, 120000, 240000, 300000, 300000]) {
      now += delay - 1;
      await worker.tick();
      expect(commits).toBe(attempts);
      expect(worker.lastError).toContain("Quota exceeded.");
      now++;
      await expect(worker.tick()).rejects.toThrow("Quota exceeded.");
      expect(commits).toBe(++attempts);
    }
    fail = false;
    now += 300000;
    await worker.tick();
    expect(worker.lastError).toBeNull();
    expect(polls).toBe(2);
    await worker.tick();
    expect(commits).toBe(attempts + 1);
    expect(polls).toBe(2);
    now += 59999;
    await worker.tick();
    expect(polls).toBe(2);
    now++;
    await worker.tick();
    expect(polls).toBe(4);
    store.save({ ...page(), content: "Next call" }, 0, 300);
    fail = true;
    await expect(worker.tick()).rejects.toThrow("Quota exceeded.");
    fail = false;
    now += 15000;
    await worker.tick();
    expect(worker.lastError).toBeNull();
    await worker.tick();
    expect(commits).toBe(attempts + 3);
  } finally {
    clock.mockRestore();
    store.close();
  }
});

test("overlapping Firebase ticks share one upload and retain messages received during the request", async () => {
  const store = new Store(":memory:", true);
  let commits = 0;
  let polls = 0;
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.endsWith(":commit")) {
        if (++commits === 1) {
          started.resolve();
          await release;
        }
        return Response.json({});
      }
      polls++;
      return Response.json({ documents: [] });
    },
  );
  try {
    store.save(page(), 0, 300);
    const worker = new FirebaseWorker(store, client);
    const first = worker.tick();
    expect(worker.tick()).toBe(first);
    await started.promise;
    store.save({ ...page(), content: "Next call" }, 0, 300);
    resolve();
    await first;
    expect(commits).toBe(1);
    expect(polls).toBe(2);
    await worker.tick();
    await worker.tick();
    expect(commits).toBe(2);
    expect(polls).toBe(2);
  } finally {
    store.close();
  }
});

test("service account JWT is signed for Firestore, token is reused, and member approval is strict", async () => {
  let oauth = 0;
  let approved: unknown = true;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url === "https://oauth2.googleapis.com/token") {
        oauth++;
        const assertion = (options.body as URLSearchParams).get("assertion")!;
        const [header, payload, signature] = assertion.split(".");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            publicKey,
            Buffer.from(signature!, "base64url"),
          ),
        ).toBe(true);
        expect(
          JSON.parse(Buffer.from(payload!, "base64url").toString()),
        ).toMatchObject({
          iss: account.client_email,
          aud: "https://oauth2.googleapis.com/token",
          scope: "https://www.googleapis.com/auth/datastore",
        });
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      expect(new Headers(options.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      if (url.includes("/members/"))
        return Response.json({
          fields: {
            approved:
              typeof approved === "boolean"
                ? { booleanValue: approved }
                : { stringValue: approved },
          },
        });
      return Response.json(document("friend", true, [999999]));
    },
  );
  const store = new Store(":memory:", true);
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.save(page(), 0, 300);
    const job = store.dueJobs("pending", Date.now())[0]!;
    // Warm token before the two concurrent authorization lookups.
    await client.get("members", "friend");
    expect(await client.authorize(job)).toBe(true);
    approved = "true";
    expect(await client.authorize(job)).toBe(false);
    approved = false;
    expect(await client.authorize(job)).toBe(false);
    expect(oauth).toBe(1);
  } finally {
    store.close();
  }
});

test("device sync ignores obsolete filters and rejects invalid tokens and unapproved recipients", async () => {
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.includes("/members?"))
        return Response.json({
          documents: [
            {
              ...document("friend"),
              fields: {
                ...document("friend").fields,
                label: { stringValue: "Friend's phone" },
              },
            },
            document("unlabelled"),
            document("bad"),
            document("denied", false),
            document("fraction"),
            document("too-large"),
          ],
        });
      return Response.json({
        documents: [
          document("friend", true, [123456]),
          document("unlabelled"),
          {
            ...document("bad", true, ["123456"]),
            fields: {
              ...document("bad").fields,
              expoPushToken: { stringValue: "invalid" },
            },
          },
          document("denied"),
          document("fraction", true, [1.5]),
          document("too-large", true, [2097152]),
        ],
      });
    },
  );
  expect(await client.devices()).toEqual([
    {
      uid: "friend",
      name: "Friend's phone",
      token: "ExpoPushToken[friend]",
    },
    {
      uid: "unlabelled",
      name: "unlabelled",
      token: "ExpoPushToken[unlabelled]",
    },
    { uid: "fraction", name: "fraction", token: "ExpoPushToken[fraction]" },
    { uid: "too-large", name: "too-large", token: "ExpoPushToken[too-large]" },
  ]);
});

test("Firebase sync updates device names without changing subscriptions or queued alerts", () => {
  const store = new Store(":memory:", true);
  const device = { uid: "friend", token: "ExpoPushToken[friend]" };
  const name = () =>
    store.db
      .query<{ name: string }, []>(
        "SELECT name FROM devices WHERE id = 'firebase:friend'",
      )
      .get()!.name;
  try {
    store.syncFirebaseDevices([device]);
    store.save(page(), 0, 300);
    const jobs = store.dueJobs("pending", Date.now());
    store.syncFirebaseDevices([{ ...device, name: "Friend's phone" }]);
    expect(name()).toBe("Friend's phone");
    expect(store.dueJobs("pending", Date.now())).toEqual(jobs);
    store.disablePush("firebase:friend", device.token);
    store.syncFirebaseDevices([{ ...device, name: "Renamed phone" }]);
    expect(name()).toBe("Renamed phone");
    expect(store.pendingCount()).toBe(0);
    store.save(page(), 0, 300);
    expect(store.pendingCount()).toBe(0);
  } finally {
    store.close();
  }
});

test("backfill retries the same documents after failure and advances only after successful commit without enqueuing old alerts", async () => {
  const store = new Store(":memory:", true);
  let fail = true;
  const uploads: string[][] = [];
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.endsWith(":commit")) {
        const body = JSON.parse(options.body as string) as {
          writes: {
            update: { name: string; fields: Record<string, object> };
          }[];
        };
        uploads.push(body.writes.map((write) => write.update.name));
        expect(body.writes[0]!.update.fields).toMatchObject({
          content: { stringValue: "TEST ČŠŽ" },
          duplicateOf: { nullValue: null },
        });
        expect(body.writes[0]!.update.fields).not.toHaveProperty("wav");
        if (fail) return new Response(null, { status: 503 });
        return Response.json({});
      }
      return Response.json({ documents: [] });
    },
  );
  try {
    store.save(page(), 0, 300);
    const worker = new FirebaseWorker(store, client);
    const now = Date.now();
    await expect(worker.tick(now)).rejects.toThrow("Firestore HTTP 503");
    expect(uploads).toHaveLength(1);
    fail = false;
    await worker.tick(now + 16000);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toEqual(uploads[1]);
    await worker.tick(now + 17000);
    expect(uploads).toHaveLength(2);
    store.syncFirebaseDevices([
      { uid: "new-friend", token: "ExpoPushToken[friend]" },
    ]);
    expect(store.pendingCount()).toBe(0);
  } finally {
    store.close();
  }
});

test("RIC sync updates changed mappings, removes deleted mappings, and skips an identical snapshot", async () => {
  const remote = new Map([
    ["42", { ric: 42, unitName: "Old name" }],
    ["43", { ric: 43, unitName: "Unchanged" }],
    ["99", { ric: 99, unitName: "Removed" }],
  ]);
  const commits: object[][] = [];
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.includes("/ricUnits?"))
        return Response.json({
          documents: Array.from(remote, ([id, unit]) => ({
            name: `projects/subpager-test/databases/(default)/documents/ricUnits/${id}`,
            fields: {
              ric: { integerValue: String(unit.ric) },
              unitName: { stringValue: unit.unitName },
            },
          })),
        });
      const body = JSON.parse(options.body as string) as {
        writes: (
          | {
              update: {
                name: string;
                fields: {
                  ric: { integerValue: string };
                  unitName: { stringValue: string };
                };
              };
            }
          | { delete: string }
        )[];
      };
      commits.push(body.writes);
      for (const write of body.writes) {
        if ("delete" in write) remote.delete(write.delete.split("/").at(-1)!);
        else
          remote.set(write.update.name.split("/").at(-1)!, {
            ric: Number(write.update.fields.ric.integerValue),
            unitName: write.update.fields.unitName.stringValue,
          });
      }
      return Response.json({});
    },
  );
  const units = [
    { ric: 42, unitName: "New name" },
    { ric: 43, unitName: "Unchanged" },
    { ric: 44, unitName: "New unit" },
  ];
  expect(await client.syncRicUnits(units)).toEqual({ updated: 2, deleted: 1 });
  expect(commits[0]).toHaveLength(3);
  expect(await client.syncRicUnits(units)).toEqual({ updated: 0, deleted: 0 });
  expect(commits).toHaveLength(1);
  expect(await client.syncRicUnits([])).toEqual({ updated: 0, deleted: 3 });
  expect(remote.size).toBe(0);
});

test("RIC sync validates the complete local snapshot before cloud access", async () => {
  const client = new FirebaseClient(account.project_id, account, async () => {
    throw new Error("Must not access Firebase");
  });
  for (const units of [
    [
      { ric: 42, unitName: "Valid" },
      { ric: -1, unitName: "Invalid" },
    ],
    [{ ric: 1.5, unitName: "Invalid" }],
    [{ ric: 2097152, unitName: "Invalid" }],
    [{ ric: 42, unitName: " \t " }],
    [
      { ric: 42, unitName: "First" },
      { ric: 42, unitName: "Duplicate" },
    ],
  ])
    await expect(client.syncRicUnits(units)).rejects.toThrow(
      "Invalid or duplicate RIC unit mapping",
    );
});

test("RIC sync command refuses a missing database without creating it or accessing Firebase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-ric-sync-"));
  const database = join(directory, "missing.sqlite");
  const config = join(directory, "config.json");
  const preload = join(directory, "transport.ts");
  const accessed = join(directory, "unexpected-cloud-access");
  try {
    await Bun.write(
      config,
      JSON.stringify({
        ...defaultConfig,
        database,
        firebase: {
          projectId: account.project_id,
          serviceAccountPath: "missing-account.json",
        },
      }),
    );
    await Bun.write(
      preload,
      `globalThis.fetch = async () => { await Bun.write(${JSON.stringify(accessed)}, "unexpected"); throw new Error("Must not access Firebase"); };`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "-e",
        'import { syncRicUnits } from "./scripts/tools"; await syncRicUnits()',
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SUBPAGER_CONFIG: config },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(output).toBe("");
    expect(errors).toContain("Database not found:");
    expect(await Bun.file(database).exists()).toBe(false);
    expect(await Bun.file(accessed).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RIC sync paginates cloud mappings and limits each commit to 500 writes", async () => {
  const sizes: number[] = [];
  let lists = 0;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.includes("/ricUnits?")) {
        lists++;
        if (lists === 1) return Response.json({ nextPageToken: "second" });
        expect(new URL(url).searchParams.get("pageToken")).toBe("second");
        return Response.json({
          documents: [
            {
              name: "projects/subpager-test/databases/(default)/documents/ricUnits/9000",
              fields: {},
            },
          ],
        });
      }
      sizes.push(
        (JSON.parse(options.body as string) as { writes: object[] }).writes
          .length,
      );
      return Response.json({});
    },
  );
  expect(
    await client.syncRicUnits(
      Array.from({ length: 501 }, (_, ric) => ({
        ric,
        unitName: `Unit ${ric}`,
      })),
    ),
  ).toEqual({ updated: 501, deleted: 1 });
  expect(sizes).toEqual([500, 2]);
});

test("cloud mode skips legacy keys and cancels pending alerts on token change or permission loss", () => {
  const store = new Store(":memory:", true);
  try {
    const legacy = store.addDevice("legacy");
    store.registerDevice(legacy.id, "ExpoPushToken[legacy]");
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[first]" },
    ]);
    store.save(page(), 0, 300);
    expect(
      store.dueJobs("pending", Date.now()).map((job) => job.deviceId),
    ).toEqual(["firebase:friend"]);
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[second]" },
    ]);
    expect(store.pendingCount()).toBe(0);
    store.save(page(), 0, 300);
    store.syncFirebaseDevices([]);
    expect(store.pendingCount()).toBe(0);
  } finally {
    store.close();
  }
});

test("revocation and authorization failure never reach the push transport", async () => {
  for (const fails of [false, true]) {
    const store = new Store(":memory:", true);
    try {
      store.syncFirebaseDevices([
        { uid: "friend", token: "ExpoPushToken[friend]" },
      ]);
      store.save(page(), 0, 300);
      let sends = 0;
      const worker = new PushWorker(
        store,
        async () => {
          sends++;
          throw new Error("must not send");
        },
        undefined,
        async () => {
          if (fails) throw new Error("network failure");
          return false;
        },
      );
      await worker.tick();
      expect(sends).toBe(0);
      expect(store.pendingCount()).toBe(fails ? 1 : 0);
      expect(store.db.query("SELECT error FROM push_jobs").get()).toEqual({
        error: fails
          ? "Could not check device approval"
          : "Device approval or subscription changed",
      });
    } finally {
      store.close();
    }
  }
});

test("alerts wait for their history document when backfill spans multiple batches", async () => {
  const store = new Store(":memory:", true);
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.endsWith(":commit")) return Response.json({});
      if (url.includes("/members/") || url.includes("/devices/"))
        return Response.json(document("friend"));
      return Response.json({ documents: [document("friend")] });
    },
  );
  try {
    for (let i = 0; i < 100; i++) store.save(page(), 0, 300);
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.save(page(), 0, 300);
    const cloud = new FirebaseWorker(store, client);
    let sends = 0;
    const push = new PushWorker(
      store,
      async () => {
        sends++;
        return Response.json({ data: [{ status: "ok", id: "ticket" }] });
      },
      undefined,
      (job) => cloud.authorize(job),
    );
    const now = Date.now();
    await cloud.tick(now);
    await push.tick(now);
    expect(sends).toBe(0);
    expect(store.pendingCount()).toBe(1);
    await cloud.tick(now + 1000);
    await push.tick(now + 2000);
    expect(sends).toBe(1);
    expect(store.pendingCount()).toBe(0);
  } finally {
    store.close();
  }
});

test("a rejected Expo token stays disabled across sync until the phone supplies a new token", async () => {
  const store = new Store(":memory:", true);
  const device = { uid: "friend", token: "ExpoPushToken[old]" };
  try {
    store.syncFirebaseDevices([device]);
    store.save(page(), 0, 300);
    const push = new PushWorker(store, async () =>
      Response.json({
        data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
      }),
    );
    await push.tick();
    store.syncFirebaseDevices([device]);
    store.save(page(), 0, 300);
    expect(store.pendingCount()).toBe(0);
    store.syncFirebaseDevices([{ ...device, token: "ExpoPushToken[new]" }]);
    store.save(page(), 0, 300);
    expect(
      store.dueJobs("pending", Date.now()).map((job) => job.expoPushToken),
    ).toEqual(["ExpoPushToken[new]"]);
  } finally {
    store.close();
  }
});

test("rejected token cleanup preserves filters, retries quota failures and allows fresh same-token registration", async () => {
  const store = new Store(":memory:", true);
  const now = Date.now();
  const token = "ExpoPushToken[friend]";
  let remoteToken: string | null = token;
  let version = document("friend").updateTime;
  let quota = true;
  let patches = 0;
  const remote = () => ({
    ...document("friend", true, [123456]),
    updateTime: version,
    fields: {
      ...document("friend", true, [123456]).fields,
      expoPushToken:
        remoteToken === null
          ? { nullValue: null }
          : { stringValue: remoteToken },
    },
  });
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.endsWith(":commit")) return Response.json({});
      if (url.includes("/members?"))
        return Response.json({ documents: [document("friend")] });
      if (url.includes("/devices?"))
        return Response.json({ documents: [remote()] });
      if (url.includes("/members/")) return Response.json(document("friend"));
      if (options.method === "PATCH") {
        patches++;
        const query = new URL(url).searchParams;
        expect(query.get("updateMask.fieldPaths")).toBe("expoPushToken");
        expect(query.get("currentDocument.updateTime")).toBe(version);
        expect(JSON.parse(options.body as string)).toEqual({
          fields: { expoPushToken: { nullValue: null } },
        });
        if (quota)
          return Response.json(
            { error: { message: "Quota exceeded." } },
            { status: 429 },
          );
        remoteToken = null;
        version = "2026-10-08T10:01:00.123456Z";
      }
      return Response.json(remote());
    },
  );
  const cloud = new FirebaseWorker(store, client);
  try {
    await cloud.tick(now);
    store.save(page(), 0, 300);
    await cloud.tick(now + 1000);
    const push = new PushWorker(
      store,
      async () =>
        Response.json({
          data: [
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        }),
      undefined,
      (job) => cloud.authorize(job),
    );
    await push.tick(now + 1000);
    expect(store.rejectedPushTokens()).toEqual([
      { id: "firebase:friend", token, updateTime: version },
    ]);
    await expect(cloud.tick(now + 2000)).rejects.toThrow("Quota exceeded");
    await cloud.tick(now + 2001);
    expect(patches).toBe(1);
    store.syncFirebaseDevices([{ uid: "friend", token }]);
    store.save(page(), 0, 300);
    expect(store.pendingCount()).toBe(0);
    quota = false;
    await cloud.tick(now + 18000);
    expect(patches).toBe(2);
    expect(remoteToken).toBeNull();
    expect(store.rejectedPushTokens()).toEqual([]);
    expect(remote().fields.rics).toEqual(
      document("friend", true, [123456]).fields.rics,
    );
    remoteToken = token;
    version = "2026-10-08T10:02:00.123456Z";
    await cloud.tick(now + 61000);
    store.save(page(), 0, 300);
    expect(
      store.dueJobs("pending", now + 61000).map((job) => job.expoPushToken),
    ).toEqual([token]);
  } finally {
    store.close();
  }
});

for (const nextToken of ["ExpoPushToken[friend]", "ExpoPushToken[new]"]) {
  test(`late rejected receipts preserve newer registration ${nextToken} across restart`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "subpager-rejected-receipt-"),
    );
    const path = join(directory, "history.sqlite");
    let store = new Store(path, true);
    const now = Date.now();
    let remote = document("friend");
    let patches = 0;
    const client = new FirebaseClient(
      account.project_id,
      account,
      async (url, options) => {
        if (url.includes("oauth2"))
          return Response.json({ access_token: "test", expires_in: 3600 });
        if (url.endsWith(":runQuery")) return cursorResponse(1);
        if (url.endsWith(":commit")) return Response.json({});
        if (url.includes("/members?"))
          return Response.json({ documents: [document("friend")] });
        if (url.includes("/devices?"))
          return Response.json({ documents: [remote] });
        if (url.includes("/members/")) return Response.json(document("friend"));
        if (options.method === "PATCH") patches++;
        return Response.json(remote);
      },
    );
    try {
      store.syncFirebaseDevices([
        { uid: "friend", token: "ExpoPushToken[friend]" },
      ]);
      store.save(page(), 0, 300);
      const cloud = new FirebaseWorker(store, client);
      await cloud.tick(now);
      const transport = async (url: string) =>
        Response.json({
          data: url.endsWith("send")
            ? [{ status: "ok", id: "ticket" }]
            : {
                ticket: {
                  status: "error",
                  details: { error: "DeviceNotRegistered" },
                },
              },
        });
      await new PushWorker(store, transport, undefined, (job) =>
        cloud.authorize(job),
      ).tick(now + 1000);
      store.close();
      store = new Store(path, true);
      expect(
        store.dueJobs("receipt", now + 15 * 60000 + 2000)[0]?.deviceUpdateTime,
      ).toBe(remote.updateTime);
      remote = {
        ...remote,
        updateTime: "2026-10-08T10:01:00.123457Z",
        fields: {
          ...remote.fields,
          expoPushToken: { stringValue: nextToken },
        },
      };
      await new PushWorker(store, transport).tick(now + 15 * 60000 + 2000);
      await new FirebaseWorker(store, client).tick(now + 15 * 60000 + 2000);
      expect(patches).toBe(0);
      expect(store.rejectedPushTokens()).toEqual([]);
      store.save(page(), 0, 300);
      expect(
        store
          .dueJobs("pending", Date.now() + 1000)
          .map((job) => job.expoPushToken),
      ).toEqual([nextToken]);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("legacy rejections pin a version before cleanup and preserve re-registration after a lost response", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "subpager-rejected-migration-"),
  );
  const path = join(directory, "history.sqlite");
  let store = new Store(path, true);
  const now = Date.now();
  let remote = document("friend");
  let patches = 0;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse(1);
      if (url.includes("/members?"))
        return Response.json({ documents: [document("friend")] });
      if (url.includes("/devices?"))
        return Response.json({ documents: [remote] });
      if (options.method === "PATCH") {
        patches++;
        expect(store.rejectedPushTokens()[0]?.updateTime).toBe(
          remote.updateTime,
        );
        // The write reached Firestore, but its response was lost. The phone then
        // registered the same token again with a newer document version.
        remote = { ...remote, updateTime: "2026-10-08T10:02:00.654321Z" };
        throw new Error("Response lost");
      }
      return Response.json(remote);
    },
  );
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    const message = store.save(page(), 0, 300);
    store.saveRecording(new Uint8Array([1, 2, 3]), [message]);
    const jobs = store.dueJobs("pending", now + 1000);
    store.db.exec(`
      ALTER TABLE devices DROP COLUMN rejected_push_token;
      ALTER TABLE devices DROP COLUMN rejected_update_time;
      ALTER TABLE push_jobs DROP COLUMN sent_device_update_time;
      CREATE TABLE firebase_rejected_tokens (device_id TEXT PRIMARY KEY, token TEXT NOT NULL);
      INSERT INTO firebase_rejected_tokens VALUES ('firebase:friend', 'ExpoPushToken[friend]');
      UPDATE devices SET expo_push_token = NULL;
    `);
    store.close();
    store = new Store(path, true);
    expect(
      store.db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'firebase_rejected_tokens'",
        )
        .all(),
    ).toEqual([]);
    expect(store.rejectedPushTokens()).toEqual([
      {
        id: "firebase:friend",
        token: "ExpoPushToken[friend]",
        updateTime: null,
      },
    ]);
    expect(store.list({ limit: 100 }).messages).toEqual([message]);
    expect(store.getRecording(message.id)?.wav).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      store.db.query("SELECT count(*) AS count FROM push_jobs").get(),
    ).toEqual({ count: jobs.length });
    await expect(new FirebaseWorker(store, client).tick(now)).rejects.toThrow(
      "Response lost",
    );
    store.close();
    store = new Store(path, true);
    expect(store.rejectedPushTokens()[0]?.updateTime).toBe(
      document("friend").updateTime,
    );
    await new FirebaseWorker(store, client).tick(now + 15000);
    expect(patches).toBe(1);
    expect(store.rejectedPushTokens()).toEqual([]);
    store.save(page(), 0, 300);
    expect(
      store.dueJobs("pending", now + 15000).map((job) => job.expoPushToken),
    ).toEqual(["ExpoPushToken[friend]"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration changed between cleanup read and write survives a failed precondition", async () => {
  const store = new Store(":memory:", true);
  const now = Date.now();
  let remote = document("friend");
  let patches = 0;
  const client = new FirebaseClient(
    account.project_id,
    account,
    async (url, options) => {
      if (url.includes("oauth2"))
        return Response.json({ access_token: "test", expires_in: 3600 });
      if (url.endsWith(":runQuery")) return cursorResponse();
      if (url.includes("/members?"))
        return Response.json({ documents: [document("friend")] });
      if (url.includes("/devices?"))
        return Response.json({ documents: [remote] });
      if (options.method === "PATCH") {
        patches++;
        expect(
          new URL(url).searchParams.get("currentDocument.updateTime"),
        ).toBe(remote.updateTime);
        remote = {
          ...remote,
          updateTime: "2026-10-08T10:02:00.654321Z",
          fields: {
            ...remote.fields,
            expoPushToken: { stringValue: "ExpoPushToken[new]" },
          },
        };
        return Response.json(
          {
            error: {
              status: "FAILED_PRECONDITION",
              message: "Document changed",
            },
          },
          { status: 400 },
        );
      }
      return Response.json(remote);
    },
  );
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.disablePush(
      "firebase:friend",
      "ExpoPushToken[friend]",
      remote.updateTime,
    );
    const cloud = new FirebaseWorker(store, client);
    await expect(cloud.tick(now)).rejects.toThrow("Document changed");
    expect(store.rejectedPushTokens()).toHaveLength(1);
    await cloud.tick(now + 16000);
    expect(patches).toBe(1);
    expect(store.rejectedPushTokens()).toEqual([]);
    store.save(page(), 0, 300);
    expect(
      store.dueJobs("pending", now + 16000).map((job) => job.expoPushToken),
    ).toEqual(["ExpoPushToken[new]"]);
  } finally {
    store.close();
  }
});

test("a local subscription cancelled during authorization cannot be sent", async () => {
  const store = new Store(":memory:", true);
  try {
    store.syncFirebaseDevices([
      { uid: "friend", token: "ExpoPushToken[friend]" },
    ]);
    store.save(page(), 0, 300);
    let sends = 0;
    const push = new PushWorker(
      store,
      async () => {
        sends++;
        throw new Error("must not send");
      },
      undefined,
      async () => {
        store.syncFirebaseDevices([]);
        return true;
      },
    );
    await push.tick();
    expect(sends).toBe(0);
  } finally {
    store.close();
  }
});

test("Firebase startup backfills without opening an HTTP listener or sending legacy alerts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-firebase-"));
  const database = join(directory, "history.sqlite");
  const config = join(directory, "config.json");
  const preload = join(directory, "transport.ts");
  const synced = join(directory, "synced");
  const unexpected = join(directory, "unexpected-push");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let store: Store | undefined;
  try {
    store = new Store(database);
    const legacy = store.addDevice("legacy");
    store.registerDevice(legacy.id, "ExpoPushToken[legacy]");
    store.save(page(), 0, 300);
    await Bun.write(join(directory, "account.json"), JSON.stringify(account));
    await Bun.write(
      config,
      JSON.stringify({
        ...defaultConfig,
        database,
        clips: { ...defaultConfig.clips, enabled: false },
        firebase: {
          projectId: account.project_id,
          serviceAccountPath: "account.json",
        },
      }),
    );
    await Bun.write(
      preload,
      `
      Bun.serve = () => { throw new Error("Unexpected HTTP listener"); };
      globalThis.fetch = async (url) => {
        if (url.includes("oauth2")) return Response.json({access_token:"test",expires_in:3600});
        if (url.includes("exp.host")) {
          await Bun.write(${JSON.stringify(unexpected)}, "unexpected");
          throw new Error("Unexpected push");
        }
        if (url.endsWith(":runQuery")) return Response.json([{readTime:"2026-10-08T10:00:00Z"}]);
        if (url.endsWith(":commit")) {
          await Bun.write(${JSON.stringify(synced)}, "uploaded");
          return Response.json({});
        }
        if (url.includes("/members?")) await Bun.write(${JSON.stringify(synced)}, "synced");
        return Response.json({documents:[]});
      };
    `,
    );
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
          SUBPAGER_NO_RADIO: "1",
        },
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    for (let i = 0; i < 40 && !(await Bun.file(synced).exists()); i++)
      await Bun.sleep(50);
    expect(await Bun.file(synced).exists()).toBe(true);
    child.kill();
    expect(await child.exited).toBe(0);
    expect(await output).toContain("Subpager Firebase: subpager-test");
    expect(await errors).toBe("");
    expect(
      store.db
        .query("SELECT name FROM sqlite_master WHERE name = 'firebase_sync'")
        .all(),
    ).toEqual([]);
    expect(await Bun.file(unexpected).exists()).toBe(false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
