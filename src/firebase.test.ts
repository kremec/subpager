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
  filters: { key: string; operation: string; value: string }[] = [];
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
  where(key: string, operation: string, value: string) {
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
            const value = fields[filter.key] as string;
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

test("message, push and location jobs commit together, and persisted IDs prevent duplicate retries", async () => {
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
  expect(documents.size).toBe(5);
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
  const committed = [...documents.entries()];
  await backend.ingest([reception], true, now);
  await expect(
    backend.ingest([{ ...reception, content: "different" }], true, now),
  ).rejects.toThrow("conflicting content");
  expect([...documents.entries()]).toEqual(committed);
});

test("dedupe stays anchored to the canonical page and copies resolved locations", async () => {
  const { backend, documents } = database();
  const first = page();
  const second = page(25_000);
  const third = page(40_000);
  await backend.ingest([first], true, Date.parse(first.receivedAt));
  documents.get(`messages/${first.sourceId}`)!.location = "ŠOLA GOLO";
  await backend.ingest([second, third], true, Date.parse(first.receivedAt));
  expect(documents.get(`messages/${second.sourceId}`)?.duplicateOf).toBe(
    first.sourceId,
  );
  expect(documents.get(`messages/${second.sourceId}`)?.location).toBe(
    "ŠOLA GOLO",
  );
  expect(documents.has(`locationJobs/${second.sourceId}`)).toBe(false);
  expect(documents.get(`messages/${third.sourceId}`)?.duplicateOf).toBeNull();
  expect(documents.has(`locationJobs/${third.sourceId}`)).toBe(true);
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
  const tone = { ...page(80_000), type: "tone" as const, content: "" };
  const empty = { ...page(120_000), content: "<EOT><NUL>" };
  await backend.ingest([tone, empty], true, Date.parse(tone.receivedAt));
  expect(documents.has(`locationJobs/${tone.sourceId}`)).toBe(false);
  expect(documents.has(`locationJobs/${empty.sourceId}`)).toBe(false);
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

test("one thousand RIC mappings publish as an atomic versioned catalog", async () => {
  const { backend, documents, fail } = database();
  const units = Array.from({ length: 1000 }, (_, ric) => ({
    ric,
    unitName: `Unit ${ric}`,
  }));
  await backend.syncRicUnits(units);
  expect(documents.size).toBe(2);
  const catalog = documents.get("config/ricUnits")!;
  expect(catalog.units).toEqual(units);
  expect(documents.get("config/ricUnitsRevision")?.revision).toBe(
    catalog.revision,
  );
  const committed = [...documents.entries()];
  fail(true);
  await expect(backend.syncRicUnits([])).rejects.toThrow(
    "Commit not acknowledged",
  );
  expect([...documents.entries()]).toEqual(committed);
  fail(false);
  await backend.syncRicUnits([]);
  expect(documents.get("config/ricUnits")?.units).toEqual([]);
  expect(documents.get("config/ricUnitsRevision")?.revision).not.toBe(
    catalog.revision,
  );
});

test("an oversized RIC catalog is rejected before any writes", async () => {
  const { backend, documents } = database();
  await expect(
    backend.syncRicUnits([{ ric: 1, unitName: "x".repeat(900_000) }]),
  ).rejects.toThrow("RIC catalog exceeds");
  expect(documents.size).toBe(0);
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
