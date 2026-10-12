import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Timestamp,
  FieldValue,
  Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { FirebaseBackend } from "./firebase";
import type { Reception } from "./outbox";

const idGenerator = new Firestore({ projectId: "subpager-test" });
type Fields = Record<string, unknown>;
interface Reference {
  path: string;
  id: string;
}
class Collection {
  filters: { key: string; operation: string; value: string | boolean }[] = [];
  descending = false;
  maximum = Infinity;
  constructor(
    readonly path: string,
    private documents: Map<string, Fields>,
  ) {}
  doc(id = idGenerator.collection(this.path).doc().id) {
    const path = `${this.path}/${id}`;
    return {
      path,
      id,
      set: async (fields: Fields, options?: { merge: boolean }) => {
        this.documents.set(path, {
          ...(options?.merge ? this.documents.get(path) : {}),
          ...fields,
        });
      },
    };
  }
  where(key: string, operation: string, value: string | boolean) {
    this.filters.push({ key, operation, value });
    return this;
  }
  limit(maximum: number) {
    this.maximum = maximum;
    return this;
  }
  orderBy(_key: string, direction: string) {
    this.descending = direction === "desc";
    return this;
  }
  get() {
    const docs = [...this.documents.entries()]
      .filter(
        ([path, fields]) =>
          path.startsWith(`${this.path}/`) &&
          this.filters.every((filter) => {
            const value = fields[filter.key] as string | boolean;
            if (filter.operation === "array-contains")
              return Array.isArray(value) && value.includes(filter.value);
            if (filter.operation === "==") return value === filter.value;
            return filter.operation === ">="
              ? value >= filter.value
              : value <= filter.value;
          }),
      )
      .map(([path, fields]) =>
        snapshot({ path, id: path.split("/")[1]! }, fields),
      );
    if (this.descending)
      docs.sort((a, b) =>
        String(b.get("receivedAt")).localeCompare(String(a.get("receivedAt"))),
      );
    return { docs: docs.slice(0, this.maximum) };
  }
  onSnapshot(success: (snapshot: ReturnType<Collection["get"]>) => void) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) success(this.get());
    });
    return () => {
      cancelled = true;
    };
  }
}
function snapshot(reference: Reference, fields?: Fields) {
  return {
    ...reference,
    ref: reference,
    exists: fields !== undefined,
    data: () => fields,
    get: (key: string) => fields?.[key],
    updateTime: Timestamp.fromMillis(1),
  };
}
function database() {
  const documents = new Map<string, Fields>();
  let failCommit = false;
  let loseAcknowledgement = false;
  const db = {
    collection: (name: string) => new Collection(name, documents),
    bulkWriter: () => ({
      set: async (reference: Reference, fields: Fields) => {
        if (failCommit) throw new Error("Commit not acknowledged");
        documents.set(reference.path, fields);
      },
      delete: async (reference: Reference) => {
        if (failCommit) throw new Error("Commit not acknowledged");
        documents.delete(reference.path);
      },
      close: async () => {},
    }),
    batch: () => {
      const writes: (() => void)[] = [];
      return {
        set: (reference: Reference, fields: Fields) =>
          writes.push(() => documents.set(reference.path, fields)),
        commit: async () => {
          if (failCommit) throw new Error("Commit not acknowledged");
          for (const write of writes) write();
        },
      };
    },
    runTransaction: async (
      callback: (transaction: Transaction) => Promise<void>,
    ) => {
      const writes: (() => void)[] = [];
      const transaction = {
        get: async (target: Reference | Collection) => {
          if (writes.length) throw new Error("Read after transaction write");
          return target instanceof Collection
            ? target.get()
            : snapshot(target, documents.get(target.path));
        },
        create: (reference: Reference, fields: Fields) => {
          if (documents.has(reference.path))
            throw new Error("Existing document");
          writes.push(() => documents.set(reference.path, fields));
        },
        update: (reference: Reference, fields: Fields) =>
          writes.push(() =>
            documents.set(reference.path, {
              ...documents.get(reference.path),
              ...fields,
            }),
          ),
        set: (reference: Reference, fields: Fields) =>
          writes.push(() => documents.set(reference.path, fields)),
        delete: (reference: Reference) =>
          writes.push(() => documents.delete(reference.path)),
      };
      await callback(transaction as never);
      if (failCommit) throw new Error("Commit not acknowledged");
      for (const write of writes) write();
      if (loseAcknowledgement) throw new Error("Commit acknowledgement lost");
    },
  };
  return {
    backend: new FirebaseBackend(db as never as Firestore),
    documents,
    loseAcknowledgement: (value: boolean) => {
      loseAcknowledgement = value;
    },
    fail: (value: boolean) => {
      failCommit = value;
    },
  };
}
function page(offset = 0, source = offset + 1): Reception {
  return {
    sourceId: `Reception${String(source).padStart(11, "0")}`,
    receivedAt: new Date(1_790_000_000_000 + offset).toISOString(),
    ric: 123,
    function: 3,
    type: "alpha",
    content: "ŠOLA<LF>GOLO<EOT><NUL>",
  };
}

test("deletions retain a readable marker, remove pending jobs atomically and suppress reception retries", async () => {
  const { backend, documents, fail } = database();
  const reception = page();
  const path = `messages/${reception.sourceId}`;
  await backend.ingest([reception], false);
  documents.set(path, {
    ...documents.get(path),
    location: "Old location",
    spinEventId: "472470",
    spinMatchStatus: "confirmed",
  });
  documents.set(`locationJobs/${reception.sourceId}`, { active: true });
  documents.set(`spinJobs/${reception.sourceId}`, { active: true });
  documents.set("pushJobs/matching", {
    active: true,
    messageId: reception.sourceId,
  });
  documents.set("pushJobs/other", { active: true, messageId: "other" });
  documents.set("pushJobs/completed", {
    active: false,
    messageId: reception.sourceId,
  });
  fail(true);
  await expect(backend.deleteMessage(reception.sourceId)).rejects.toThrow(
    "Commit not acknowledged",
  );
  expect(documents.get(path)?.content).toBe("ŠOLA GOLO");
  expect(documents.has(`spinJobs/${reception.sourceId}`)).toBe(true);
  expect(documents.has("pushJobs/matching")).toBe(true);
  fail(false);
  await backend.deleteMessage(reception.sourceId);
  expect(documents.get(path)).toEqual({
    receptions: [{ ric: reception.ric, time: reception.receivedAt }],
    function: reception.function,
    type: reception.type,
    content: "ŠOLA GOLO",
    location: "Old location",
    spinEventId: "472470",
    spinMatchStatus: "confirmed",
    deleted: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  expect(documents.has(`locationJobs/${reception.sourceId}`)).toBe(false);
  expect(documents.has(`spinJobs/${reception.sourceId}`)).toBe(false);
  expect(documents.has("pushJobs/matching")).toBe(false);
  expect(documents.has("pushJobs/other")).toBe(true);
  expect(documents.has("pushJobs/completed")).toBe(true);
  const deleted = [...documents.entries()];
  await backend.ingest([reception], false);
  await backend.deleteMessage(reception.sourceId);
  expect([...documents.entries()]).toEqual(deleted);
  await expect(backend.deleteMessage("missing")).rejects.toThrow(
    "Message is missing",
  );
  await expect(backend.deleteMessage("../invalid")).rejects.toThrow(
    "Invalid message ID",
  );
});

test("message, push, location and SPIN jobs commit together, and persisted IDs prevent duplicate retries", async () => {
  const { backend, documents, fail } = database();
  documents.set("users/approved", {
    expoPushToken: "ExponentPushToken[test]",
    approved: true,
  });
  documents.set("users/unapproved", {
    expoPushToken: "ExponentPushToken[other]",
    approved: false,
  });
  const reception = page();
  const now = Date.parse(reception.receivedAt);
  fail(true);
  await expect(backend.ingest([reception], true, now)).rejects.toThrow(
    "Commit not acknowledged",
  );
  expect(documents.size).toBe(2);
  fail(false);
  await backend.ingest([reception], true, now);
  expect(documents.size).toBe(6);
  const message = documents.get(`messages/${reception.sourceId}`)!;
  expect(message.content).toBe("ŠOLA GOLO");
  expect(message.sourceId).toBeUndefined();
  expect(message.id).toBeUndefined();
  expect(message.updatedAt).toEqual(FieldValue.serverTimestamp());
  const [pushPath, push] = [...documents.entries()].find(([path]) =>
    path.startsWith("pushJobs/"),
  )!;
  expect(pushPath).toMatch(/^pushJobs\/[A-Za-z0-9]{20}$/);
  expect(push.messageId).toBe(reception.sourceId);
  expect(push.body).toBe("ŠOLA GOLO");
  expect(push.title).toBe("0000123 · 21/09/2026, 16:13");
  expect(push.recipients).toEqual([
    {
      deviceId: "approved",
      expoPushToken: "ExponentPushToken[test]",
      tokenUpdatedAt: Timestamp.fromMillis(1),
      state: "pending",
      nextAttempt: now,
      attempts: 0,
    },
  ]);
  expect(documents.get(`locationJobs/${reception.sourceId}`)?.content).toBe(
    "ŠOLA GOLO",
  );
  expect(documents.get(`spinJobs/${reception.sourceId}`)).toEqual({
    active: true,
    state: "pending",
    expiresAt: now + 3 * 24 * 60 * 60 * 1000,
    nextAttempt: now,
    attempts: 0,
    failures: 0,
    leaseUntil: 0,
  });
  const committed = [...documents.entries()];
  await backend.ingest([reception], true, now);
  await expect(
    backend.ingest([{ ...reception, content: "different" }], true, now),
  ).rejects.toThrow("conflicting content");
  expect([...documents.entries()]).toEqual(committed);
});

test("content defines one event with all RIC/time pairs, while later sessions still alert", async () => {
  const { backend, documents } = database();
  documents.set("users/device", {
    approved: true,
    expoPushToken: "ExponentPushToken[test]",
  });
  const first = page();
  const second = { ...page(25_000), ric: 456 };
  const third = page(360_000);
  await backend.ingest([first], true, Date.parse(first.receivedAt));
  documents.get(`messages/${first.sourceId}`)!.location = "ŠOLA GOLO";
  await backend.ingest([second], true, Date.parse(second.receivedAt));
  expect(
    [...documents.keys()].filter((path) => path.startsWith("pushJobs/")),
  ).toHaveLength(1);
  await backend.ingest([third], true, Date.parse(third.receivedAt));
  expect(
    [...documents.keys()].filter((path) => path.startsWith("messages/")),
  ).toEqual([`messages/${first.sourceId}`]);
  expect(documents.get(`messages/${first.sourceId}`)).toMatchObject({
    receptions: [first, second, third].map((item) => ({
      ric: item.ric,
      time: item.receivedAt,
    })),
    location: "ŠOLA GOLO",
  });
  for (const key of ["ric", "rics", "receivedAt", "sourceIds"])
    expect(documents.get(`messages/${first.sourceId}`)).not.toHaveProperty(key);
  expect(
    [...documents.keys()].filter((path) => path.startsWith("pushJobs/")),
  ).toHaveLength(2);
  const committed = [...documents.entries()];
  const restarted = new FirebaseBackend(backend.db);
  await restarted.ingest(
    [second, third],
    true,
    Date.parse(third.receivedAt) + 86_400_000,
  );
  expect([...documents.entries()]).toEqual(committed);
  await restarted.deleteMessage(first.sourceId);
  const afterDelete = [...documents.entries()];
  await restarted.ingest([first, second, third], false);
  expect([...documents.entries()]).toEqual(afterDelete);
});

test("out-of-order uploads preserve chronological history, including repeated RICs", async () => {
  const { backend, documents } = database();
  const newer = page(120_000);
  const older = { ...page(), ric: 456 };
  const latest = page(86_400_000);
  await backend.ingest([newer, older, latest], false);
  expect(documents.get(`messages/${newer.sourceId}`)?.receptions).toEqual(
    [older, newer, latest].map((item) => ({
      ric: item.ric,
      time: item.receivedAt,
    })),
  );
  expect(
    [...documents.keys()].filter((path) => path.startsWith("messages/")),
  ).toHaveLength(1);
});

test("ready incident results survive a later paging session", async () => {
  const { backend, documents } = database();
  const first = page();
  await backend.ingest([first], true, Date.parse(first.receivedAt));
  const ref = `spinJobs/${first.sourceId}`;
  documents.set(ref, {
    ...documents.get(ref),
    state: "ready",
    result: { id: "paid-result" },
  });
  const paid = documents.get(ref);
  const later = page(86_400_000);
  await backend.ingest([later], true, Date.parse(later.receivedAt));
  expect(documents.get(ref)?.state).toBe("ready");
  expect(documents.get(ref)?.result).toEqual(paid?.result);
  expect(documents.get(ref)?.attempts).toBe(paid?.attempts);
  expect(documents.get(ref)?.reviewAfterPublish).toBe(true);
});

test("out-of-order receptions do not alert a paging session twice", async () => {
  for (const offsets of [
    [1_000, 0],
    [0, 240_000, 181_000],
  ]) {
    const { backend, documents } = database();
    documents.set("users/device", {
      approved: true,
      expoPushToken: "ExponentPushToken[test]",
    });
    for (const offset of offsets) {
      const reception = page(offset);
      await backend.ingest(
        [reception],
        true,
        Date.parse(page(Math.max(...offsets)).receivedAt),
      );
    }
    expect(
      [...documents.keys()].filter((path) => path.startsWith("pushJobs/")),
    ).toHaveLength(offsets.length - 1);
  }
});

test("imports suppress all jobs, expiry suppresses push, and tone/empty pages skip inference", async () => {
  const { backend, documents } = database();
  documents.set("users/device", {
    expoPushToken: "ExponentPushToken[test]",
    approved: true,
  });
  await backend.ingest([page()], false, Date.parse(page().receivedAt));
  expect(
    [...documents.keys()].filter((key) => key.includes("Jobs/")),
  ).toHaveLength(0);
  const expired = { ...page(40_000), content: "Expired" };
  await backend.ingest(
    [expired],
    true,
    Date.parse(expired.receivedAt) + 300_000,
  );
  expect(
    [...documents.keys()].filter((key) => key.startsWith("pushJobs/")),
  ).toHaveLength(0);
  expect(documents.has(`locationJobs/${expired.sourceId}`)).toBe(true);
  expect(documents.has(`spinJobs/${expired.sourceId}`)).toBe(true);
  const tone = { ...page(80_000), type: "tone" as const, content: "" };
  const empty = { ...page(120_000), content: "<EOT><NUL>" };
  await backend.ingest([tone, empty], true, Date.parse(tone.receivedAt));
  expect(documents.has(`locationJobs/${tone.sourceId}`)).toBe(false);
  expect(documents.has(`locationJobs/${empty.sourceId}`)).toBe(false);
  expect(documents.has(`spinJobs/${tone.sourceId}`)).toBe(false);
  expect(documents.has(`spinJobs/${empty.sourceId}`)).toBe(false);
  expect(
    [...documents.keys()].filter((key) => key.startsWith("pushJobs/")),
  ).toHaveLength(2);
});

test.each(["Reception00000000001", "00000000-0000-4000-8000-000000000001"])(
  "a lost commit acknowledgement reuses the persisted message ID %s and its jobs",
  async (sourceId) => {
    const { backend, documents, loseAcknowledgement } = database();
    documents.set("users/device", {
      expoPushToken: "ExponentPushToken[test]",
      approved: true,
    });
    const reception = { ...page(), sourceId };
    loseAcknowledgement(true);
    await expect(
      backend.ingest([reception], true, Date.parse(reception.receivedAt)),
    ).rejects.toThrow("Commit acknowledgement lost");
    expect(documents.has(`messages/${sourceId}`)).toBe(true);
    expect(documents.has(`spinJobs/${sourceId}`)).toBe(true);
    const committed = [...documents.entries()];
    loseAcknowledgement(false);
    await backend.ingest([reception], true, Date.parse(reception.receivedAt));
    expect([...documents.entries()]).toEqual(committed);
  },
);

test("devices share one bounded push job per message and reception retries do not fan out twice", async () => {
  const { backend, documents } = database();
  for (const uid of ["one", "two"]) {
    documents.set(`users/${uid}`, {
      expoPushToken: `ExponentPushToken[${uid}]`,
      approved: true,
    });
  }
  const first = page();
  const second = { ...page(1), content: "Different call" };
  await backend.ingest([first, second], true, Date.parse(first.receivedAt));
  const pushes = [...documents.entries()].filter(([path]) =>
    path.startsWith("pushJobs/"),
  );
  expect(pushes).toHaveLength(2);
  for (const [path] of pushes)
    expect(path).toMatch(/^pushJobs\/[A-Za-z0-9]{20}$/);
  expect(pushes.map(([, fields]) => fields.messageId)).toEqual([
    first.sourceId,
    second.sourceId,
  ]);
  for (const [, fields] of pushes)
    expect(
      (fields.recipients as { deviceId: string }[]).map(
        (recipient) => recipient.deviceId,
      ),
    ).toEqual(["one", "two"]);
  expect(documents.get(`locationJobs/${first.sourceId}`)?.messageId).toBe(
    first.sourceId,
  );
  const committed = [...documents.entries()];
  await backend.ingest([first, second], true, Date.parse(first.receivedAt));
  expect([...documents.entries()]).toEqual(committed);
});

test("251 push recipients require three jobs and no user query in the ingest transaction", async () => {
  const { backend, documents } = database();
  for (let index = 0; index < 251; index++)
    documents.set(`users/${index}`, {
      approved: true,
      expoPushToken: `ExponentPushToken[${index}]`,
    });
  const reception = page();
  await backend.ingest([reception], true, Date.parse(reception.receivedAt));
  const jobs = [...documents.entries()].filter(([path]) =>
    path.startsWith("pushJobs/"),
  );
  expect(jobs.map(([, job]) => (job.recipients as object[]).length)).toEqual([
    100, 100, 51,
  ]);
});

test("one thousand RIC mappings publish as flat documents and empty imports clear them", async () => {
  const { backend, documents, fail } = database();
  documents.set("ricUnits/_placeholder", { placeholder: true });
  const units = Array.from({ length: 1000 }, (_, ric) => ({
    ric,
    unitName: `Unit ${ric}`,
  }));
  await backend.syncRicUnits(units);
  expect(documents.size).toBe(1000);
  expect(documents.has("ricUnits/_placeholder")).toBe(false);
  expect(documents.get("ricUnits/999")).toEqual(units[999]);
  const committed = [...documents.entries()];
  fail(true);
  await expect(backend.syncRicUnits([])).rejects.toThrow(
    "Commit not acknowledged",
  );
  expect([...documents.entries()]).toEqual(committed);
  fail(false);
  await backend.syncRicUnits([]);
  expect(documents.size).toBe(0);
});

test("RIC import updates names and removes omitted mappings without changing messages", async () => {
  const { backend, documents } = database();
  documents.set("messages/example", { content: "Original pager" });
  await backend.syncRicUnits([
    { ric: 123, unitName: "Old name" },
    { ric: 456, unitName: "Removed unit" },
  ]);
  await backend.syncRicUnits([{ ric: 123, unitName: "New name" }]);
  expect(documents.get("ricUnits/123")).toEqual({
    ric: 123,
    unitName: "New name",
  });
  expect(documents.has("ricUnits/456")).toBe(false);
  expect(documents.get("messages/example")).toEqual({
    content: "Original pager",
  });
});

test.each(["../message", "", "23", "invalid-ID-of-20-char"])(
  "invalid message ID %s is rejected before any writes",
  async (sourceId) => {
    const { backend, documents } = database();
    await expect(backend.ingest([{ ...page(), sourceId }])).rejects.toThrow(
      "Invalid pager reception",
    );
    expect(documents.size).toBe(0);
  },
);

test("approval changes preserve the user's token and label, and optional labels are saved", async () => {
  const { backend, documents } = database();
  const token = "ExponentPushToken[test]";
  documents.set("users/device", {
    expoPushToken: token,
    label: "Existing device",
    approved: false,
  });
  await backend.setMember("device", true);
  expect(documents.get("users/device")).toEqual({
    expoPushToken: token,
    label: "Existing device",
    approved: true,
  });
  await backend.setMember("device", false, "  [DEV] Android Emulator  ");
  expect(documents.get("users/device")).toEqual({
    expoPushToken: token,
    label: "[DEV] Android Emulator",
    approved: false,
  });
  await backend.setMember("device", true, "   ");
  await backend.setMember("history-only", true, "History only");
  expect(await backend.devices()).toEqual([
    {
      uid: "device",
      approved: true,
      label: "[DEV] Android Emulator",
      expoPushToken: token,
    },
    {
      uid: "history-only",
      approved: true,
      label: "History only",
      expoPushToken: null,
    },
  ]);
});

test("a service account from another project is rejected before SDK initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpager-firebase-"));
  const serviceAccountPath = join(directory, "account.json");
  try {
    await Bun.write(
      serviceAccountPath,
      JSON.stringify({ project_id: "another-project" }),
    );
    await expect(
      FirebaseBackend.open({
        projectId: "expected-project",
        serviceAccountPath,
      }),
    ).rejects.toThrow("does not match");
  } finally {
    await rm(directory, { recursive: true });
  }
});
