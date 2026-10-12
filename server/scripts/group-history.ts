import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { loadConfig } from "../src/config";
import { FirebaseBackend } from "../src/firebase";
import { canGroupPages } from "../src/pager-group";
import type { Page } from "../src/radio/decoder";

const collections = [
  "messages",
  "locationJobs",
  "spinJobs",
  "pushJobs",
] as const;
type Collection = (typeof collections)[number];
type Data = Record<string, unknown>;
export interface HistoryDocument {
  id: string;
  data: Data;
}
export type History = Record<Collection, HistoryDocument[]>;
interface Change {
  collection: Collection;
  id: string;
  data?: Data;
}
export interface HistoryGroup {
  id: string;
  rics: number[];
  changes: Change[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id) => typeof id === "string")
    : [];
}

/** Stop the receiver and all workers before applying this offline migration. */
export function planHistoryGrouping(
  history: History,
  now = Date.now(),
): HistoryGroup[] {
  const messages = new Map(history.messages.map((doc) => [doc.id, doc]));
  const archivedOwners = new Map<string, string>();
  for (const doc of history.messages)
    if (doc.data.duplicateOf == null)
      for (const id of strings(doc.data.sourceIds))
        if (id !== doc.id) archivedOwners.set(id, doc.id);
  const roots = new Map<string, HistoryDocument[]>();
  for (const message of history.messages) {
    let root = message;
    const visited = new Set<string>();
    for (;;) {
      const parentId =
        typeof root.data.duplicateOf === "string"
          ? root.data.duplicateOf
          : root.data.deleted === true
            ? archivedOwners.get(root.id)
            : undefined;
      if (!parentId) break;
      if (visited.has(root.id))
        throw new Error(`Duplicate cycle at ${root.id}`);
      visited.add(root.id);
      const parent = messages.get(parentId);
      if (!parent) throw new Error(`Missing duplicate target for ${root.id}`);
      root = parent;
    }
    const members = roots.get(root.id) ?? [];
    members.push(message);
    roots.set(root.id, members);
  }
  const groups: { anchor: HistoryDocument; members: HistoryDocument[] }[] = [];
  for (const [rootId, members] of [...roots].sort(([a], [b]) => {
    const delta =
      Date.parse(messages.get(a)!.data.receivedAt as string) -
      Date.parse(messages.get(b)!.data.receivedAt as string);
    return delta || a.localeCompare(b);
  })) {
    const root = messages.get(rootId)!;
    const eventIds = new Set(
      members.map((doc) => doc.data.spinEventId).filter(Boolean),
    );
    if (eventIds.size > 1)
      throw new Error(`Conflicting SPIN links in legacy group ${rootId}`);
    const group =
      root.data.deleted === true
        ? undefined
        : groups.find((candidate) => {
            if (
              candidate.anchor.data.deleted === true ||
              !canGroupPages(
                candidate.anchor.data as unknown as Page,
                root.data as unknown as Page,
              )
            )
              return false;
            const links = new Set(
              [...candidate.members, ...members]
                .map((doc) => doc.data.spinEventId)
                .filter(Boolean),
            );
            return links.size <= 1;
          });
    if (group) group.members.push(...members);
    else groups.push({ anchor: root, members });
  }
  const owners = new Set<string>();
  return groups
    .map(({ anchor, members }) => {
      members = [anchor, ...members.filter((doc) => doc.id !== anchor.id)];
      const merged = { ...anchor.data };
      delete merged.duplicateOf;
      const rics = [
        ...new Set(
          members.flatMap((doc) => [
            doc.data.ric as number,
            ...(Array.isArray(doc.data.rics)
              ? (doc.data.rics as number[])
              : []),
          ]),
        ),
      ];
      const sourceIds = [
        ...new Set(
          members.flatMap((doc) => [doc.id, ...strings(doc.data.sourceIds)]),
        ),
      ];
      for (const id of sourceIds) {
        if (owners.has(id))
          throw new Error(`Reception ${id} belongs to multiple groups`);
        owners.add(id);
      }
      merged.rics = rics;
      merged.sourceIds = sourceIds;
      const changes: Change[] = [];
      const spinJob = history.spinJobs.find((doc) => doc.id === anchor.id);
      const retainedSpin = spinJob ? { ...spinJob.data } : undefined;
      const linked = members.find(
        (doc) => typeof doc.data.spinEventId === "string",
      );
      if (anchor.data.deleted !== true) {
        // A location can only underline text present in the canonical message.
        const location = members
          .map((doc) => doc.data.location)
          .find(
            (value) =>
              typeof value === "string" &&
              value.length > 0 &&
              (merged.content as string).includes(value),
          );
        if (location) merged.location = location;
        else if (merged.location) delete merged.location;
        if (
          location &&
          location !== anchor.data.location &&
          retainedSpin?.active &&
          retainedSpin.state !== "ready"
        ) {
          retainedSpin.state = "pending";
          delete retainedSpin.checkedRevision;
          retainedSpin.attempts = Number(retainedSpin.attempts ?? 0) + 1;
          retainedSpin.leaseUntil = 0;
          retainedSpin.nextAttempt = now;
        }
        if (!merged.spinEventId && linked) {
          const result = spinJob?.data.result as { id?: string } | undefined;
          // Preserve a paid ready result if it will publish a different decision.
          if (
            spinJob?.data.state !== "ready" ||
            result?.id === linked.data.spinEventId
          ) {
            merged.spinEventId = linked.data.spinEventId;
            if (linked.data.spinMatchStatus)
              merged.spinMatchStatus = linked.data.spinMatchStatus;
            if (retainedSpin)
              retainedSpin.reviewEventId = linked.data.spinEventId;
          }
        }
        if (
          merged.spinEventId &&
          members.some(
            (doc) =>
              doc.data.spinEventId === merged.spinEventId &&
              doc.data.spinMatchStatus === "confirmed",
          )
        )
          merged.spinMatchStatus = "confirmed";
        const rejected = [
          ...new Set(
            members.flatMap((doc) => strings(doc.data.spinRejectedEventIds)),
          ),
        ];
        if (rejected.length) merged.spinRejectedEventIds = rejected;
      }
      if (
        spinJob &&
        retainedSpin &&
        JSON.stringify(retainedSpin) !== JSON.stringify(spinJob.data)
      )
        changes.push({
          collection: "spinJobs",
          id: spinJob.id,
          data: retainedSpin,
        });
      if (JSON.stringify(merged) !== JSON.stringify(anchor.data))
        changes.push({ collection: "messages", id: anchor.id, data: merged });
      const removed = new Set<string>();
      for (const member of members) {
        if (member.id === anchor.id) {
          if (anchor.data.deleted === true) removed.add(member.id);
          continue;
        }
        const tombstone: Data = { ...member.data, deleted: true };
        delete tombstone.sourceIds;
        delete tombstone.duplicateOf;
        if (JSON.stringify(tombstone) !== JSON.stringify(member.data))
          changes.push({
            collection: "messages",
            id: member.id,
            data: tombstone,
          });
        removed.add(member.id);
      }
      for (const collection of [
        "locationJobs",
        "spinJobs",
        "pushJobs",
      ] as const)
        for (const doc of history[collection])
          if (
            removed.has(
              collection === "pushJobs"
                ? (doc.data.messageId as string)
                : doc.id,
            )
          )
            changes.push({ collection, id: doc.id });
      return { id: anchor.id, rics, changes };
    })
    .filter((group) => group.changes.length > 0);
}

async function groupHistory() {
  const args = Bun.argv.slice(2);
  const apply = args.includes("--apply");
  if (
    args.some(
      (arg, index) =>
        !["--apply", "--receiver-stopped", "--backup-dir"].includes(arg) &&
        args[index - 1] !== "--backup-dir",
    )
  )
    throw new Error(
      "Usage: bun scripts/group-history.ts [--apply --receiver-stopped --backup-dir DIRECTORY]",
    );
  if (apply && !args.includes("--receiver-stopped"))
    throw new Error(
      "Stop the receiver and workers, then pass --receiver-stopped to apply",
    );
  if (
    apply &&
    (!args.includes("--backup-dir") || !args[args.indexOf("--backup-dir") + 1])
  )
    throw new Error(
      "Pass --backup-dir DIRECTORY outside the repository before applying",
    );
  const config = await loadConfig();
  const client = await FirebaseBackend.open(config.firebase);
  try {
    const snapshots = await Promise.all(
      collections.map((name) => client.db.collection(name).get()),
    );
    const history = Object.fromEntries(
      collections.map((name, index) => [
        name,
        snapshots[index]!.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      ]),
    ) as History;
    const groups = planHistoryGrouping(history);
    const writes = groups.reduce(
      (total, group) => total + group.changes.length,
      0,
    );
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        messages: history.messages.length,
        groups: groups.length,
        writes,
        preview: groups.slice(0, 20).map(({ id, rics, changes }) => ({
          id,
          rics,
          writes: changes.length,
        })),
      }),
    );
    if (!apply || writes === 0) return;
    if (groups.some((group) => group.changes.length > 450))
      throw new Error(
        "A group exceeds the safe transaction limit; nothing has been changed",
      );
    const backupIndex = args.indexOf("--backup-dir");
    const directory = resolve(
      backupIndex < 0
        ? resolve(homedir(), ".subpager-backups")
        : (args[backupIndex + 1] ?? ""),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const actualDirectory = await realpath(directory);
    const inside = relative(
      await realpath(resolve(import.meta.dir, "../..")),
      actualDirectory,
    );
    if (inside === "" || (!inside.startsWith("../") && inside !== ".."))
      throw new Error("Backup directory must be outside the repository");
    const backup = resolve(actualDirectory, `group-history-${Date.now()}.json`);
    await writeFile(
      backup,
      JSON.stringify({
        projectId: config.firebase.projectId,
        createdAt: new Date().toISOString(),
        collections: Object.fromEntries(
          collections.map((name, index) => [
            name,
            snapshots[index]!.docs.map((doc) => ({
              id: doc.id,
              updateTime: doc.updateTime,
              data: doc.data(),
            })),
          ]),
        ),
      }),
      { flag: "wx", mode: 0o600 },
    );
    const original = new Map(
      snapshots.flatMap((snapshot) =>
        snapshot.docs.map((doc) => [doc.ref.path, doc.updateTime]),
      ),
    );
    for (const group of groups) {
      await client.db.runTransaction(async (transaction) => {
        const refs = group.changes.map((change) =>
          client.db.collection(change.collection).doc(change.id),
        );
        const current = await transaction.getAll(...refs);
        for (const doc of current) {
          const previous = original.get(doc.ref.path);
          if (!doc.exists || !previous || !doc.updateTime?.isEqual(previous))
            throw new Error(
              `Concurrent write at ${doc.ref.path}; stop all workers before retrying`,
            );
        }
        for (const [index, change] of group.changes.entries()) {
          const ref = refs[index]!;
          if (change.data)
            transaction.set(ref, {
              ...change.data,
              ...(change.collection === "messages"
                ? { updatedAt: FieldValue.serverTimestamp() }
                : {}),
            });
          else transaction.delete(ref);
        }
      });
    }
    console.log(`Applied ${groups.length} groups; backup saved to ${backup}`);
  } finally {
    await client.db.terminate();
  }
}

if (import.meta.main) await groupHistory();
