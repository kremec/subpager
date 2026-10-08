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
    return { docs };
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
    },
  };
  return {
    backend: new FirebaseBackend(db as never as Firestore),
    documents,
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
  fail(false);
  await backend.ingest([reception], true, now);
  expect(documents.size).toBe(7);
  expect(documents.get(`messages/${reception.sourceId}`)?.content).toBe(
    "ŠOLA GOLO",
  );
  const push = documents.get(`pushJobs/${reception.sourceId}_approved`)!;
  expect(push.body).toBe("ŠOLA GOLO");
  expect(push.title).toBe("0000123 · 21/09/2026, 16:13");
  expect(push.tokenUpdatedAt).toEqual(Timestamp.fromMillis(1));
  expect(documents.get(`locationJobs/${reception.sourceId}`)?.content).toBe(
    "ŠOLA GOLO",
  );
  await backend.ingest([reception], true, now);
  expect(documents.size).toBe(7);
  await expect(
    backend.ingest([{ ...reception, content: "different" }], true, now),
  ).rejects.toThrow("conflicting content");
  expect(documents.size).toBe(7);
});

test("dedupe stays anchored to the canonical page and copies resolved locations", async () => {
  const { backend, documents } = database();
  const first = page();
  await backend.ingest([first], true, Date.parse(first.receivedAt));
  documents.get(`messages/${first.sourceId}`)!.location = "ŠOLA GOLO";
  await backend.ingest(
    [page(25_000), page(40_000)],
    true,
    Date.parse(first.receivedAt),
  );
  expect(documents.get(`messages/${page(25_000).sourceId}`)?.duplicateOf).toBe(
    first.sourceId,
  );
  expect(documents.get(`messages/${page(25_000).sourceId}`)?.location).toBe(
    "ŠOLA GOLO",
  );
  expect(documents.has(`locationJobs/${page(25_000).sourceId}`)).toBe(false);
  expect(
    documents.get(`messages/${page(40_000).sourceId}`)?.duplicateOf,
  ).toBeNull();
  expect(documents.has(`locationJobs/${page(40_000).sourceId}`)).toBe(true);
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
  expect(documents.has(`pushJobs/${expired.sourceId}_device`)).toBe(false);
  expect(documents.has(`locationJobs/${expired.sourceId}`)).toBe(true);
  const tone = { ...page(80_000), type: "tone" as const, content: "" };
  const empty = { ...page(120_000), content: "<EOT><NUL>" };
  await backend.ingest([tone, empty], true, Date.parse(tone.receivedAt));
  expect(documents.has(`locationJobs/${tone.sourceId}`)).toBe(false);
  expect(documents.has(`locationJobs/${empty.sourceId}`)).toBe(false);
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
