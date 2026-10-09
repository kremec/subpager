import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { FirebaseBackend } from "./firebase";
import type { Reception } from "./outbox";

type Fields = Record<string, string | number | boolean | null | Timestamp>;
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
  doc(id: string): Reference {
    return { path: `${this.path}/${id}`, id };
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
    sourceId: `00000000-0000-4000-8000-${String(source).padStart(12, "0")}`,
    receivedAt: new Date(1_790_000_000_000 + offset).toISOString(),
    ric: 123,
    function: 3,
    type: "alpha",
    content: "ŠOLA<LF>GOLO<EOT><NUL>",
  };
}

test("message, push and location jobs commit together, and UUID retries never recreate them", async () => {
  const { backend, documents, fail } = database();
  documents.set("devices/approved", {
    expoPushToken: "ExponentPushToken[test]",
  });
  documents.set("members/approved", { approved: true });
  documents.set("devices/unapproved", {
    expoPushToken: "ExponentPushToken[other]",
  });
  documents.set("members/unapproved", { approved: false });
  const reception = page();
  const now = Date.parse(reception.receivedAt);
  fail(true);
  await expect(backend.ingest([reception], true, now)).rejects.toThrow(
    "Commit not acknowledged",
  );
  expect(documents.size).toBe(4);
  expect(documents.has("counters/ids")).toBe(false);
  fail(false);
  await backend.ingest([reception], true, now);
  expect(documents.get("counters/ids")).toEqual({ messages: 1, pushJobs: 1 });
  expect(documents.size).toBe(8);
  expect(documents.get("messages/1")?.content).toBe("ŠOLA GOLO");
  const push = documents.get("pushJobs/1")!;
  expect(push.messageId).toBe("1");
  expect(documents.get("messages/1")?.sourceId).toBe(reception.sourceId);
  expect(documents.get("messages/1")?.id).toBeUndefined();
  expect(push.body).toBe("ŠOLA GOLO");
  expect(push.title).toBe("0000123 · 21/09/2026, 16:13");
  expect(push.tokenUpdatedAt).toEqual(Timestamp.fromMillis(1));
  expect(documents.get("locationJobs/1")?.content).toBe("ŠOLA GOLO");
  await backend.ingest([reception], true, now);
  expect(documents.size).toBe(8);
  await expect(
    backend.ingest([{ ...reception, content: "different" }], true, now),
  ).rejects.toThrow("conflicting content");
  expect(documents.size).toBe(8);
  expect(documents.get("counters/ids")).toEqual({ messages: 1, pushJobs: 1 });
});

test("dedupe stays anchored to the canonical page and copies resolved locations", async () => {
  const { backend, documents } = database();
  const first = page();
  await backend.ingest([first], true, Date.parse(first.receivedAt));
  documents.get("messages/1")!.location = "ŠOLA GOLO";
  await backend.ingest(
    [page(25_000), page(40_000)],
    true,
    Date.parse(first.receivedAt),
  );
  expect(documents.get("messages/2")?.duplicateOf).toBe("1");
  expect(documents.get("messages/2")?.location).toBe("ŠOLA GOLO");
  expect(documents.has("locationJobs/2")).toBe(false);
  expect(documents.get("messages/3")?.duplicateOf).toBeNull();
  expect(documents.has("locationJobs/3")).toBe(true);
  expect(documents.get("counters/ids")).toEqual({ messages: 3, pushJobs: 0 });
});

test("imports suppress all jobs, expiry suppresses push, and tone/empty pages skip inference", async () => {
  const { backend, documents } = database();
  documents.set("devices/device", { expoPushToken: "ExponentPushToken[test]" });
  documents.set("members/device", { approved: true });
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
  expect(documents.has("pushJobs/1")).toBe(false);
  expect(documents.has("locationJobs/2")).toBe(true);
  const tone = { ...page(80_000), type: "tone" as const, content: "" };
  const empty = { ...page(120_000), content: "<EOT><NUL>" };
  await backend.ingest([tone, empty], true, Date.parse(tone.receivedAt));
  expect(documents.has("locationJobs/3")).toBe(false);
  expect(documents.has("locationJobs/4")).toBe(false);
  expect(documents.get("counters/ids")).toEqual({ messages: 4, pushJobs: 2 });
});

test("a lost commit acknowledgement reuses numeric IDs and the UUID source key", async () => {
  const { backend, documents, loseAcknowledgement } = database();
  documents.set("devices/device", { expoPushToken: "ExponentPushToken[test]" });
  documents.set("members/device", { approved: true });
  loseAcknowledgement(true);
  await expect(
    backend.ingest([page()], true, Date.parse(page().receivedAt)),
  ).rejects.toThrow("Commit acknowledgement lost");
  expect(documents.get("counters/ids")).toEqual({ messages: 1, pushJobs: 1 });
  const committed = [...documents.entries()];
  loseAcknowledgement(false);
  await backend.ingest([page()], true, Date.parse(page().receivedAt));
  expect([...documents.entries()]).toEqual(committed);
});

test("allocation continues from imported counters and numbers multi-device push jobs sequentially", async () => {
  const { backend, documents } = database();
  documents.set("counters/ids", { messages: 22, pushJobs: 7 });
  for (const uid of ["one", "two"]) {
    documents.set(`devices/${uid}`, {
      expoPushToken: `ExponentPushToken[${uid}]`,
    });
    documents.set(`members/${uid}`, { approved: true });
  }
  const first = page();
  const second = { ...page(1), content: "Different call" };
  await backend.ingest([first, second], true, Date.parse(first.receivedAt));
  expect(documents.get("counters/ids")).toEqual({ messages: 24, pushJobs: 11 });
  expect(documents.get("messages/23")?.sourceId).toBe(first.sourceId);
  expect(documents.get("messages/24")?.sourceId).toBe(second.sourceId);
  expect(documents.get("locationJobs/23")?.messageId).toBe("23");
  expect(documents.get("locationJobs/24")?.messageId).toBe("24");
  expect(
    ["8", "9", "10", "11"].map(
      (id) => documents.get(`pushJobs/${id}`)?.messageId,
    ),
  ).toEqual(["23", "23", "24", "24"]);
  const committed = [...documents.entries()];
  await backend.ingest([first, second], true, Date.parse(first.receivedAt));
  expect([...documents.entries()]).toEqual(committed);
});

test.each([
  { messages: -1, pushJobs: 0 },
  { messages: 0.5, pushJobs: 0 },
  { messages: Number.MAX_SAFE_INTEGER, pushJobs: 0 },
  { messages: 0, pushJobs: -1 },
  { messages: 0, pushJobs: Number.MAX_SAFE_INTEGER },
])(
  "invalid or exhausted counters roll back every message and job write: %j",
  async (ids) => {
    const { backend, documents } = database();
    documents.set("counters/ids", ids);
    documents.set("devices/device", {
      expoPushToken: "ExponentPushToken[test]",
    });
    documents.set("members/device", { approved: true });
    const initial = [...documents.entries()];
    await expect(
      backend.ingest([page()], true, Date.parse(page().receivedAt)),
    ).rejects.toThrow();
    expect([...documents.entries()]).toEqual(initial);
  },
);

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
