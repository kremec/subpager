import { expect, test } from "bun:test";
import {
  planHistoryGrouping,
  type History,
  type HistoryDocument,
} from "./group-history";

function message(
  id: string,
  minutes = 0,
  data: Record<string, unknown> = {},
): HistoryDocument {
  return {
    id,
    data: {
      receivedAt: new Date(Date.UTC(2026, 9, 12, 12, minutes)).toISOString(),
      ric: Number(id),
      function: 0,
      type: "alpha",
      content: "POZAR V HISI NA CESTI 34",
      ...data,
    },
  };
}

function history(
  messages: HistoryDocument[],
  jobs: Partial<Omit<History, "messages">> = {},
): History {
  return { messages, locationJobs: [], spinJobs: [], pushJobs: [], ...jobs };
}

test("groups oldest-first against a fixed anchor and preserves its raw payload", () => {
  const plan = planHistoryGrouping(
    history([message("3", 4), message("2", 2), message("1", 0)]),
  );
  const canonical = plan.find((group) => group.id === "1")!;
  expect(canonical.rics).toEqual([1, 2]);
  expect(canonical.changes.find((change) => change.id === "1")!.data).toEqual({
    ...message("1").data,
    rics: [1, 2],
    sourceIds: ["1", "2"],
  });
  expect(plan.find((group) => group.id === "3")!.rics).toEqual([3]);
});

test("keeps different SPIN events in separate groups", () => {
  const plan = planHistoryGrouping(
    history([
      message("1", 0, { spinEventId: "event-a" }),
      message("2", 1, { spinEventId: "event-b" }),
      message("3", 2),
    ]),
  );
  expect(plan.map((group) => group.rics)).toEqual([[1, 3], [2]]);
});

test("absorbs legacy deleted chains, with readable tombstones and complete job cleanup", () => {
  const plan = planHistoryGrouping(
    history(
      [
        message("1"),
        message("2", 1, {
          deleted: true,
          duplicateOf: "1",
          sourceIds: ["old"],
        }),
        message("3", 2, { deleted: true, duplicateOf: "2" }),
      ],
      {
        locationJobs: [{ id: "2", data: { active: false } }],
        spinJobs: [{ id: "3", data: { active: false } }],
        pushJobs: [{ id: "push", data: { messageId: "2", active: false } }],
      },
    ),
  );
  const changes = plan[0]!.changes;
  expect(changes.find((change) => change.id === "1")!.data!.sourceIds).toEqual([
    "1",
    "2",
    "old",
    "3",
  ]);
  const tombstone = changes.find(
    (change) => change.id === "2" && change.collection === "messages",
  )!.data!;
  expect(tombstone.deleted).toBe(true);
  expect(tombstone.content).toBe(message("2").data.content);
  expect(tombstone).not.toHaveProperty("sourceIds");
  expect(tombstone).not.toHaveProperty("duplicateOf");
  expect(
    changes
      .filter((change) => !change.data)
      .map((change) => change.collection)
      .sort(),
  ).toEqual(["locationJobs", "pushJobs", "spinJobs"]);
});

test("manually deleted messages stay deleted and do not absorb similar live calls", () => {
  const plan = planHistoryGrouping(
    history([message("1", 0, { deleted: true }), message("2", 1)]),
  );
  expect(plan.map((group) => group.rics)).toEqual([[1], [2]]);
  expect(plan[0]!.changes[0]!.data).toMatchObject({
    deleted: true,
    sourceIds: ["1"],
  });
});

test("copies location only when it is an exact canonical substring and merges SPIN metadata", () => {
  const plan = planHistoryGrouping(
    history([
      message("1", 0, {
        location: "NAPAKA",
        spinEventId: "event",
        spinMatchStatus: "provisional",
        spinRejectedEventIds: ["rejected-a"],
      }),
      message("2", 1, {
        location: "CESTI 34",
        spinEventId: "event",
        spinMatchStatus: "confirmed",
        spinRejectedEventIds: ["rejected-b"],
      }),
    ]),
  );
  expect(
    plan[0]!.changes.find((change) => change.id === "1")!.data,
  ).toMatchObject({
    location: "CESTI 34",
    spinEventId: "event",
    spinMatchStatus: "confirmed",
    spinRejectedEventIds: ["rejected-a", "rejected-b"],
  });
});

test("keeps a paid ready job consistent when copying its event link", () => {
  const plan = planHistoryGrouping(
    history(
      [
        message("1"),
        message("2", 1, { spinEventId: "event", spinMatchStatus: "confirmed" }),
      ],
      {
        spinJobs: [
          {
            id: "1",
            data: {
              state: "ready",
              active: true,
              result: { id: "event" },
              attempts: 2,
            },
          },
        ],
      },
    ),
  );
  expect(
    plan[0]!.changes.find((change) => change.collection === "spinJobs")!.data,
  ).toMatchObject({
    state: "ready",
    result: { id: "event" },
    reviewEventId: "event",
    attempts: 2,
  });
});

test("retains revalidation after copying a provisional link to a waiting job", () => {
  const plan = planHistoryGrouping(
    history(
      [
        message("1"),
        message("2", 1, {
          spinEventId: "event",
          spinMatchStatus: "provisional",
        }),
      ],
      {
        spinJobs: [
          { id: "1", data: { state: "waiting", active: true, attempts: 2 } },
        ],
      },
    ),
  );
  expect(
    plan[0]!.changes.find((change) => change.collection === "spinJobs")!.data,
  ).toMatchObject({
    state: "waiting",
    reviewEventId: "event",
    attempts: 2,
  });
});

test("copied location wakes a retained waiting job without discarding a ready result", () => {
  const plan = planHistoryGrouping(
    history([message("1"), message("2", 1, { location: "CESTI 34" })], {
      spinJobs: [
        {
          id: "1",
          data: {
            state: "waiting",
            active: true,
            attempts: 2,
            checkedRevision: "old",
            leaseUntil: 42,
          },
        },
      ],
    }),
    1000,
  );
  const job = plan[0]!.changes.find(
    (change) => change.collection === "spinJobs",
  )!.data!;
  expect(job).toMatchObject({
    state: "pending",
    attempts: 3,
    leaseUntil: 0,
    nextAttempt: 1000,
  });
  expect(job).not.toHaveProperty("checkedRevision");
});

test("preserves a different paid ready decision instead of replacing it with a donor link", () => {
  const plan = planHistoryGrouping(
    history([message("1"), message("2", 1, { spinEventId: "event" })], {
      spinJobs: [
        { id: "1", data: { state: "ready", result: { id: "other-event" } } },
      ],
    }),
  );
  expect(
    plan[0]!.changes.find((change) => change.id === "1")!.data,
  ).not.toHaveProperty("spinEventId");
  expect(
    plan[0]!.changes.some((change) => change.collection === "spinJobs"),
  ).toBe(false);
});

test("the migration is idempotent with persistent merged deletion markers", () => {
  const input = history([
    message("1"),
    message("2", 1),
    message("3", 2, { deleted: true }),
  ]);
  for (const group of planHistoryGrouping(input))
    for (const change of group.changes)
      if (change.data)
        input[change.collection].find((doc) => doc.id === change.id)!.data =
          change.data;
  expect(planHistoryGrouping(input)).toEqual([]);
});

test("rejects a broken legacy chain rather than lose its source ID", () => {
  expect(() =>
    planHistoryGrouping(
      history([message("1", 0, { duplicateOf: "missing", deleted: true })]),
    ),
  ).toThrow("Missing duplicate target");
});
