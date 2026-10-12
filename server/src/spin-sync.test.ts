import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { SPIN_MATCHING_HORIZON } from "./spin";
import { SpinSync } from "./spin-sync";
import { hasSpinReport } from "./spin-feed";

const hour = 3_600_000;
const now = Date.parse("2026-10-10T14:00:00Z");
const feedUrl = "https://spin3.sos112.si/javno/ODApi/184";
let cachePath: string;

beforeEach(async () => {
  cachePath = join(
    await mkdtemp(join(tmpdir(), "subpager-spin-")),
    "candidates.json",
  );
});
afterEach(async () => {
  await rm(dirname(cachePath), { recursive: true, force: true });
});

async function cached() {
  return JSON.parse(await readFile(cachePath, "utf8")) as Record<
    string,
    unknown
  >[];
}

function feed(description: string, eventAt = now - hour): string {
  return `<rss><channel><item><title>Požar, eksplozija</title><guid>https://spin3.sos112.si/javno/zemljevid/472569</guid><description>${description}</description><pubDate>${new Date(eventAt).toUTCString()}</pubDate></item></channel></rss>`;
}

function database(initial: Record<string, unknown>[] = []) {
  const documents = new Map(
    initial.map((event) => [event.id as string, event]),
  );
  let reads = 0;
  let writes = 0;
  let failUpdates = false;
  let deleteBeforeUpdate = false;
  const db = {
    collection: (name: string) => {
      expect(name).toBe("spinEvents");
      return {
        where: (_field: string, _operator: string, cutoff: string) => ({
          get: async () => {
            reads++;
            return {
              docs: [...documents.entries()]
                .filter(([, data]) => String(data.eventAt) >= cutoff)
                .map(([id, data]) => ({
                  id,
                  data: () => data,
                  ref: {
                    update: async (patch: Record<string, unknown>) => {
                      if (failUpdates) throw new Error("Cloud update failed");
                      if (deleteBeforeUpdate) documents.delete(id);
                      if (!documents.has(id))
                        throw new Error("Missing document");
                      writes++;
                      documents.set(id, { ...documents.get(id), ...patch });
                    },
                  },
                })),
            };
          },
        }),
      };
    },
  };
  return {
    db: db as unknown as Firestore,
    documents,
    reads: () => reads,
    writes: () => writes,
    failUpdates: (value: boolean) => {
      failUpdates = value;
    },
    deleteBeforeUpdate: (value: boolean) => {
      deleteBeforeUpdate = value;
    },
  };
}

function network(state: {
  xml: string;
  detail: unknown;
  detailStatus?: number;
  feedStatus?: number;
}) {
  const calls: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/odObmocje")) {
      return Response.json({
        value: [{ items: [{ naziv: "Grosuplje" }] }],
        statusCode: 200,
      });
    }
    if (url === feedUrl)
      return new Response(state.xml, { status: state.feedStatus ?? 200 });
    expect(url).toBe("https://spin3.sos112.si/api/javno/lokacija/472569");
    return Response.json(state.detail, { status: state.detailStatus ?? 200 });
  }) as typeof fetch;
  return { calls, request };
}

test("unmatched reports stay in a private local cache and unchanged RSS skips detail fetches", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = {
    xml: feed("Grosuplje"),
    detail: { value: { obcinaNaziv: "Grosuplje" } },
  };
  const net = network(state);
  let changes = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => changes++,
    cachePath,
    net.request,
  );
  try {
    await sync.run();
    expect(sync.ready).toBe(true);
    expect(sync.events).toEqual([]);
    expect((await cached())[0]?.nextDetailAt).toBe(now + hour);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    await sync.run();
    expect(db.writes()).toBe(0);
    expect(db.documents.size).toBe(0);
    expect(db.reads()).toBe(2);
    expect(net.calls.filter((url) => url.endsWith("/odObmocje"))).toHaveLength(
      1,
    );
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      1,
    );
    expect(changes).toBe(2);
    clock.mockReturnValue(now + hour);
    await sync.run();
    expect((await cached())[0]?.nextDetailAt).toBe(now + 2 * hour);
    expect(db.writes()).toBe(0);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("partial reports with coordinates become candidates and coordinate edits change the revision", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = {
    xml: feed("Grosuplje"),
    detail: {
      value: {
        obcinaNaziv: "Grosuplje",
        dogodekNaziv: "Požari v stanovanjskih stavbah",
        wgsLatApprox: 45.956,
        wgsLonApprox: 14.658,
      },
    },
  };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    expect(sync.events).toEqual([
      {
        id: "472569",
        title: "Požar, eksplozija",
        description: "Grosuplje",
        eventAt: new Date(now - hour).toISOString(),
        municipality: "Grosuplje",
        category: "Požari v stanovanjskih stavbah",
        latitude: 45.956,
        longitude: 14.658,
      },
    ]);
    expect(db.documents.size).toBe(0);
    const revision = sync.revision;
    state.detail.value.wgsLatApprox = 45.957;
    clock.mockReturnValue(now + hour);
    await sync.run();
    expect(sync.events[0]?.latitude).toBe(45.957);
    expect(sync.revision).not.toBe(revision);
    expect(sync.events[0]).not.toHaveProperty("nextDetailAt");
    expect(db.writes()).toBe(0);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("changed RSS enables matching and sparse regressions preserve the archived report", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = {
    xml: feed("Grosuplje"),
    detail: { value: { obcinaNaziv: "Grosuplje" } },
  };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    const earlyRevision = sync.revision;
    state.xml = feed("Ob 15.22 je zagorel objekt v Grosupljem.");
    await sync.run();
    expect(sync.events).toHaveLength(1);
    expect(sync.revision).not.toBe(earlyRevision);
    expect(sync.events[0]?.description).toBe(
      "Ob 15.22 je zagorel objekt v Grosupljem.",
    );
    expect(sync.events[0]).not.toHaveProperty("rssRevision");
    expect(sync.events[0]).not.toHaveProperty("nextDetailAt");
    expect((await cached())[0]?.nextDetailAt).toBe(now + 23 * hour);
    const reportRevision = sync.revision;
    state.xml = feed("Grosuplje");
    await sync.run();
    expect(sync.revision).toBe(reportRevision);
    expect(sync.events[0]?.description).toBe(
      "Ob 15.22 je zagorel objekt v Grosupljem.",
    );
    expect(db.writes()).toBe(0);
    expect(db.documents.size).toBe(0);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("restart retains a report that left RSS and its scheduled detail follow-up", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = { xml: feed("Ob 15.22 je zagorel objekt."), detail: {} };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  let restarted: SpinSync | undefined;
  try {
    await sync.run();
    const saved = await cached();
    expect(saved[0]?.nextDetailAt).toBe(now + 23 * hour);
    expect(saved[0]?.rssRevision).toBeString();
    await sync.stop();
    state.xml = "<rss><channel /></rss>";
    restarted = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
    await restarted.run();
    expect(restarted.events[0]?.description).toBe(
      "Ob 15.22 je zagorel objekt.",
    );
    expect(await cached()).toEqual(saved);
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      1,
    );
    clock.mockReturnValue(now + 23 * hour);
    state.detail = {
      value: {
        besedilo: "Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.",
      },
    };
    await restarted.run();
    expect(restarted.events[0]?.description).toBe(
      "Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.",
    );
    expect((await cached())[0]?.nextDetailAt).toBe(now + 47 * hour);
    expect(db.writes()).toBe(0);
  } finally {
    await sync.stop();
    await restarted?.stop();
    clock.mockRestore();
  }
});

test("only existing confirmed documents receive public updates, including after a concurrent match", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = network({
    xml: feed("Ob 15.22 je zagorel objekt."),
    detail: {
      value: { obcinaNaziv: "Grosuplje", dogodekNaziv: "Požar objekta" },
    },
  });
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    expect(db.documents.size).toBe(0);
    db.documents.set("472569", {
      id: "472569",
      title: "Požar, eksplozija",
      description: "A previous public report.",
      eventAt: new Date(now - hour).toISOString(),
    });
    await sync.run();
    expect(db.documents.get("472569")).toEqual({
      ...sync.events[0],
      updatedAt: FieldValue.serverTimestamp(),
    });
    expect(db.documents.get("472569")).not.toHaveProperty("nextDetailAt");
    expect(db.documents.get("472569")).not.toHaveProperty("rssRevision");
    expect(db.writes()).toBe(1);
    await sync.run();
    expect(db.writes()).toBe(1);
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      1,
    );
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("report changes wait for linked-message review to be queued before updating the cloud report", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const previous = {
    id: "472569",
    title: "Požar",
    description: "A previous public report.",
    eventAt: new Date(now - hour).toISOString(),
  };
  const db = database([previous]);
  const net = network({ xml: feed("Gasilci so pogasili požar."), detail: {} });
  let entered = () => {};
  const queued = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reviews = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => {},
    cachePath,
    net.request,
    async (id) => {
      expect(id).toBe(previous.id);
      reviews++;
      entered();
      await gate;
    },
  );
  try {
    const running = sync.run();
    await queued;
    expect(db.documents.get(previous.id)).toEqual(previous);
    expect(db.writes()).toBe(0);
    release();
    await running;
    expect(db.documents.get(previous.id)?.description).toBe(
      "Gasilci so pogasili požar.",
    );
    expect(db.writes()).toBe(1);
    await sync.run();
    expect(reviews).toBe(1);
  } finally {
    release();
    await sync.stop();
    clock.mockRestore();
  }
});

test("failed review queueing leaves the cloud report unchanged and retries without fetching details again", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const previous = {
    id: "472569",
    title: "Požar",
    description: "A previous public report.",
    eventAt: new Date(now - hour).toISOString(),
  };
  const db = database([previous]);
  const net = network({ xml: feed("Gasilci so pogasili požar."), detail: {} });
  let reviews = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => {},
    cachePath,
    net.request,
    async () => {
      if (++reviews === 1) throw new Error("Review queue unavailable");
    },
  );
  try {
    await expect(sync.run()).rejects.toThrow("Review queue unavailable");
    expect(db.documents.get(previous.id)).toEqual(previous);
    expect(db.writes()).toBe(0);
    expect(sync.events).toEqual([]);
    expect((await cached())[0]?.description).toBe("Gasilci so pogasili požar.");
    await sync.run();
    expect(reviews).toBe(2);
    expect(db.documents.get(previous.id)?.description).toBe(
      "Gasilci so pogasili požar.",
    );
    expect(db.writes()).toBe(1);
    await sync.run();
    expect(reviews).toBe(2);
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      1,
    );
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("municipality-only candidates cannot replace a confirmed narrative", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const report = {
    id: "472569",
    title: "Požar",
    description: "Gasilci so pogasili požar.",
    eventAt: new Date(now - hour).toISOString(),
  };
  const db = database([report]);
  const net = network({ xml: feed("Grosuplje"), detail: {} });
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    expect(db.documents.get("472569")).toEqual(report);
    expect(db.writes()).toBe(0);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test.each(["outage", "deletion"])(
  "%s during a confirmed update retains local data without creating a cloud document",
  async (failure) => {
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const db = database([
      {
        id: "472569",
        title: "Požar",
        description: "A previous public report.",
        eventAt: new Date(now - hour).toISOString(),
      },
    ]);
    const net = network({
      xml: feed("Ob 15.22 je zagorel objekt."),
      detail: {},
    });
    const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
    try {
      db.failUpdates(failure === "outage");
      db.deleteBeforeUpdate(failure === "deletion");
      await expect(sync.run()).rejects.toThrow(
        failure === "outage" ? "Cloud update failed" : "Missing document",
      );
      expect((await cached())[0]?.description).toBe(
        "Ob 15.22 je zagorel objekt.",
      );
      expect(sync.events).toEqual([]);
      expect(db.writes()).toBe(0);
      db.failUpdates(false);
      db.deleteBeforeUpdate(false);
      await sync.run();
      if (failure === "outage") {
        expect(db.documents.get("472569")?.description).toBe(
          "Ob 15.22 je zagorel objekt.",
        );
        expect(db.writes()).toBe(1);
      } else {
        expect(db.documents.has("472569")).toBe(false);
        expect(db.writes()).toBe(0);
      }
      expect(
        net.calls.filter((url) => url.includes("/lokacija/")),
      ).toHaveLength(1);
    } finally {
      await sync.stop();
      clock.mockRestore();
    }
  },
);

test("failed local persistence keeps the previous catalog and complete cache until a retry succeeds", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = { xml: feed("Ob 15.22 je zagorel objekt."), detail: {} };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    const revision = sync.revision;
    const saved = await cached();
    state.xml = feed("Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.");
    await mkdir(`${cachePath}.tmp`);
    await expect(sync.run()).rejects.toThrow();
    expect(sync.revision).toBe(revision);
    expect(sync.events[0]?.description).toBe("Ob 15.22 je zagorel objekt.");
    expect(await cached()).toEqual(saved);
    expect(db.reads()).toBe(1);
    await rm(`${cachePath}.tmp`, { recursive: true });
    await sync.run();
    expect(sync.revision).not.toBe(revision);
    expect(sync.events[0]?.description).toBe(
      "Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.",
    );
    expect((await cached())[0]?.description).toBe(sync.events[0]?.description);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("retained IDs receive detail updates at 24 and 48 hours after leaving RSS", async () => {
  let time = now;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const db = database([
    {
      id: "472569",
      title: "Požar, eksplozija",
      description: "Ob 15.22 je zagorel objekt v Grosupljem.",
      eventAt: new Date(now - hour).toISOString(),
    },
  ]);
  const state = {
    xml: feed("Ob 15.22 je zagorel objekt v Grosupljem."),
    detail: {
      value: {
        obcinaNaziv: "Grosuplje",
        besedilo: "Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.",
      },
    },
  };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    state.xml = "<rss><channel /></rss>";
    time = now + 23 * hour;
    await sync.run();
    expect((await cached())[0]?.nextDetailAt).toBe(now + 47 * hour);
    time = now + 47 * hour;
    await sync.run();
    expect((await cached())[0]?.nextDetailAt).toBe(0);
    time += hour;
    await sync.run();
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      3,
    );
    expect(sync.events).toHaveLength(1);
    const revision = sync.revision;
    time = now + SPIN_MATCHING_HORIZON;
    await sync.run();
    expect(sync.events).toEqual([]);
    expect(sync.revision).not.toBe(revision);
    expect(await cached()).toEqual([]);
    expect(db.documents.get("472569")?.description).toBe(
      "Ob 15.22 je zagorel objekt. Gasilci so ga pogasili.",
    );
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("a failed detail fetch still archives RSS and schedules a five-minute retry", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const state = { xml: feed("Grosuplje"), detail: {}, detailStatus: 503 };
  const net = network(state);
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await expect(sync.run()).rejects.toThrow("SPIN HTTP 503");
    expect((await cached())[0]?.description).toBe("Grosuplje");
    expect((await cached())[0]?.nextDetailAt).toBe(now + 300_000);
    expect(db.writes()).toBe(0);
    expect(sync.ready).toBe(true);
    expect(sync.events).toEqual([]);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("startup loads only recent local candidates and preserves confirmed historical reports", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const events = [
    {
      id: "472569",
      title: "Požar",
      description: "Ob 15.22 je zagorel objekt.",
      eventAt: new Date(now - hour).toISOString(),
      nextDetailAt: 0,
      rssRevision: "source",
    },
    {
      id: "472000",
      title: "Požar",
      description: "Ob 15.22 je zagorel objekt.",
      eventAt: new Date(now - 4 * 24 * hour).toISOString(),
      nextDetailAt: now - 1,
    },
  ];
  await writeFile(cachePath, JSON.stringify(events));
  const db = database(events);
  const net = network({ xml: "<rss><channel /></rss>", detail: {} });
  let changes = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => changes++,
    cachePath,
    net.request,
  );
  try {
    expect(sync.ready).toBe(false);
    await sync.run();
    expect(sync.ready).toBe(true);
    expect(sync.events.map((event) => event.id)).toEqual(["472569"]);
    expect(sync.events[0]).not.toHaveProperty("updatedAt");
    expect(sync.events[0]).not.toHaveProperty("nextDetailAt");
    expect(db.writes()).toBe(0);
    expect(db.documents.has("472000")).toBe(true);
    expect((await cached()).map((event) => event.id)).toEqual(["472569"]);
    expect(changes).toBe(1);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("RSS items older than three days do not become candidates or cause repeated detail requests", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = network({
    xml: feed("Ob 15.22 je zagorel objekt.", now - 4 * 24 * hour),
    detail: {},
  });
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.run();
    await sync.run();
    expect(sync.ready).toBe(true);
    expect(sync.events).toEqual([]);
    expect(db.writes()).toBe(0);
    expect(net.calls.some((url) => url.includes("/lokacija/"))).toBe(false);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("failed feed polls expire old candidates and wake waiting jobs without granting initial readiness", async () => {
  let time = now;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const db = database();
  const state = {
    xml: feed("Ob 15.22 je zagorel objekt."),
    detail: {},
    feedStatus: 503,
  };
  const net = network(state);
  let changes = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => changes++,
    cachePath,
    net.request,
  );
  try {
    await expect(sync.run()).rejects.toThrow("SPIN HTTP 503");
    expect(sync.ready).toBe(false);
    expect(changes).toBe(1);
    state.feedStatus = 200;
    await sync.run();
    expect(sync.ready).toBe(true);
    expect(sync.events).toHaveLength(1);
    const revision = sync.revision;
    state.feedStatus = 503;
    time = now + SPIN_MATCHING_HORIZON;
    await expect(sync.run()).rejects.toThrow("SPIN HTTP 503");
    expect(sync.ready).toBe(true);
    expect(sync.events).toEqual([]);
    expect(sync.revision).not.toBe(revision);
    expect(changes).toBe(3);
    expect(await cached()).toEqual([]);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

function liveNetwork() {
  const state = {
    xml: "<rss><channel /></rss>",
    detail: {
      statusCode: 200,
      value: {
        obcinaNaziv: "Grosuplje",
        prijavaCas: "2026-10-10T15:00:00",
        wgsLatApprox: 45.956,
        wgsLonApprox: 14.658,
      },
    } as Record<string, any>,
  };
  const net = network(state);
  return { state, ...net };
}

function noticeTimers() {
  let id = 0;
  const callbacks = new Map<number, { run: () => void; delay: number }>();
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    run: () => void,
    delay: number,
  ) => {
    callbacks.set(++id, { run, delay });
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    (value) => {
      callbacks.delete(Number(value));
    },
  );
  return {
    callbacks,
    fire() {
      const [key, callback] = callbacks.entries().next().value!;
      callbacks.delete(key);
      callback.run();
    },
    restore() {
      timeout.mockRestore();
      clear.mockRestore();
    },
  };
}

async function waitFor(check: () => boolean) {
  const deadline = performance.now() + 1000;
  while (!check() && performance.now() < deadline) await Bun.sleep(2);
  expect(check()).toBe(true);
}

test("notices arriving during a slow read remain one coalesced pending batch", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timers = noticeTimers();
  const db = database();
  const net = liveNetwork();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const request = (async (input, init) => {
    if (String(input).includes("/lokacija/")) {
      reads++;
      if (reads === 1) await blocked;
    }
    return net.request(input, init);
  }) as typeof fetch;
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, request);
  try {
    sync.notify("472569");
    sync.notify("472569");
    expect(timers.callbacks.size).toBe(1);
    timers.fire();
    await waitFor(() => reads === 1);
    for (let index = 0; index < 20; index++) sync.notify("472569");
    expect(timers.callbacks.size).toBe(0);
    release();
    await waitFor(() => timers.callbacks.size === 1);
    timers.fire();
    await waitFor(() => reads === 2 && timers.callbacks.size === 0);
    await sync.stop();
    expect(db.reads()).toBe(1);
  } finally {
    release();
    await sync.stop();
    timers.restore();
    clock.mockRestore();
  }
});

test("failed live reads survive restart and back off while public unavailability is bounded", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timers = noticeTimers();
  const db = database();
  const net = liveNetwork();
  const request = (async (input, init) => {
    if (String(input).includes("/lokacija/")) throw new Error("offline");
    return net.request(input, init);
  }) as typeof fetch;
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, request);
  let restarted: SpinSync | undefined;
  try {
    sync.notify("472569");
    for (let attempt = 0; attempt < 3; attempt++) {
      timers.fire();
      await waitFor(() => timers.callbacks.size === 1);
    }
    expect([...timers.callbacks.values()][0]?.delay).toBe(300_000);
    expect(JSON.parse(await readFile(`${cachePath}.pending`, "utf8"))).toEqual([
      { id: "472569", expiresAt: now + SPIN_MATCHING_HORIZON },
    ]);
    await sync.stop();
    restarted = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
    await restarted.run();
    expect(timers.callbacks.size).toBe(1);
    timers.fire();
    await waitFor(() => restarted!.events.length === 1);
    await waitFor(() => timers.callbacks.size === 0);
    expect(JSON.parse(await readFile(`${cachePath}.pending`, "utf8"))).toEqual(
      [],
    );
    net.state.detail = { statusCode: 200 };
    restarted.notify("472569");
    for (let attempt = 0; attempt < 3; attempt++) {
      timers.fire();
      await waitFor(() => attempt === 2 || timers.callbacks.size === 1);
    }
    await restarted.stop();
    expect(timers.callbacks.size).toBe(0);
    expect(restarted.events).toHaveLength(1);
  } finally {
    await sync.stop();
    await restarted?.stop();
    timers.restore();
    clock.mockRestore();
  }
});

test("a startup catalogue outage preserves both existing and newly noticed IDs", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timers = noticeTimers();
  const db = database();
  await writeFile(
    `${cachePath}.pending`,
    JSON.stringify([{ id: "472568", expiresAt: now + hour }]),
  );
  const request = (async (_input: string | URL | Request) => {
    throw new Error("catalogue offline");
  }) as unknown as typeof fetch;
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, request);
  try {
    await expect(sync.refresh(["472569"])).rejects.toThrow("catalogue offline");
    expect(JSON.parse(await readFile(`${cachePath}.pending`, "utf8"))).toEqual([
      { id: "472568", expiresAt: now + hour },
      { id: "472569", expiresAt: now + SPIN_MATCHING_HORIZON },
    ]);
    expect(timers.callbacks.size).toBe(1);
  } finally {
    await sync.stop();
    timers.restore();
    clock.mockRestore();
  }
});

test("hourly detail reads keep a changed municipality-only report partial", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.refresh(["472569"]);
    net.state.detail.value.obcinaNaziv = "Cerknica";
    clock.mockReturnValue(now + hour);
    await sync.run();
    expect(sync.events[0]?.description).toBe("Cerknica");
    expect(hasSpinReport(sync.events[0]!)).toBe(false);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("a live incident missed by RSS is durable, deduplicated and refreshed after a region change", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  let changes = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => changes++,
    cachePath,
    net.request,
  );
  try {
    await sync.refresh(["472569", "472569", "../private", "0"]);
    expect(sync.events[0]).toMatchObject({
      id: "472569",
      eventAt: "2026-10-10T13:00:00.000Z",
      municipality: "Grosuplje",
    });
    expect(db.documents.size).toBe(0);
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      1,
    );
    const revision = sync.revision;
    await sync.refresh(["472569"]);
    expect(changes).toBe(1);
    expect(db.reads()).toBe(1);
    expect(sync.revision).toBe(revision);
    net.state.detail.value.obcinaNaziv = "Cerknica";
    await sync.refresh(["472569"]);
    expect(sync.events[0]?.description).toBe("Cerknica");
    expect(hasSpinReport(sync.events[0]!)).toBe(false);
    await sync.stop();

    net.state.detail.value.obcinaNaziv = "Cerknica";
    net.state.detail.value.besedilo =
      "Gasilci so pomagali poškodovanemu motoristu.";
    clock.mockReturnValue(now + hour);
    const restarted = new SpinSync(
      db.db,
      feedUrl,
      () => {},
      cachePath,
      net.request,
    );
    try {
      await restarted.run();
      expect(restarted.events[0]).toMatchObject({
        municipality: "Cerknica",
        description: net.state.detail.value.besedilo,
      });
      expect((await cached())[0]?.municipality).toBe("Cerknica");
      expect(db.documents.size).toBe(0);
    } finally {
      await restarted.stop();
    }
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("public-detail unavailability preserves captured evidence and ignores old or invalid incidents", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, net.request);
  try {
    await sync.refresh(["472569"]);
    const snapshot = await cached();
    const revision = sync.revision;
    net.state.detail = { statusCode: 200 };
    expect(await sync.refresh(["472569"])).toEqual(["472569"]);
    expect(await cached()).toEqual(snapshot);
    expect(sync.revision).toBe(revision);
    net.state.detail = {
      statusCode: 200,
      value: { obcinaNaziv: "Grosuplje", prijavaCas: "2026-10-01T15:00:00" },
    };
    const old = new SpinSync(
      db.db,
      feedUrl,
      () => {},
      cachePath + ".old",
      net.request,
    );
    try {
      await old.refresh(["472569"]);
      expect(old.events).toEqual([]);
      expect(db.documents.size).toBe(0);
    } finally {
      await old.stop();
    }
    net.state.detail = { statusCode: 403, value: {} };
    await expect(sync.refresh(["472569"])).rejects.toThrow(
      "SPIN detail request failed",
    );
    expect(sync.revision).toBe(revision);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("a live report update queues review and retries failed cloud publication without losing the new candidate", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  let reviews = 0;
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => {},
    cachePath,
    net.request,
    async () => {
      reviews++;
    },
  );
  try {
    await sync.refresh(["472569"]);
    const partial = sync.events[0]!;
    db.documents.set(partial.id, { ...partial });
    net.state.detail.value.besedilo =
      "Gasilci so pomagali poškodovanemu motoristu.";
    db.failUpdates(true);
    await expect(sync.refresh([partial.id])).rejects.toThrow(
      "Cloud update failed",
    );
    expect(sync.events[0]?.description).toBe("Grosuplje");
    expect((await cached())[0]?.description).toBe(
      net.state.detail.value.besedilo,
    );
    expect(reviews).toBe(1);
    db.failUpdates(false);
    await sync.refresh([partial.id]);
    expect(reviews).toBe(2);
    expect(sync.events[0]?.description).toBe(net.state.detail.value.besedilo);
    expect(db.writes()).toBe(1);
    expect(db.documents.get(partial.id)?.description).toBe(
      net.state.detail.value.besedilo,
    );
    await sync.refresh([partial.id]);
    expect(db.writes()).toBe(1);
    expect(reviews).toBe(2);
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("reconnect recovery refreshes known full reports before their normal daily check", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  net.state.detail.value.besedilo = "A full public report.";
  let publish = () => {};
  const sync = new SpinSync(
    db.db,
    feedUrl,
    () => publish(),
    cachePath,
    net.request,
  );
  try {
    await sync.refresh(["472569"]);
    net.state.detail.value.besedilo = "A revised full public report.";
    const updated = new Promise<void>((resolve) => {
      publish = resolve;
    });
    sync.recover();
    await updated;
    expect(sync.events[0]?.description).toBe("A revised full public report.");
    expect(net.calls.filter((url) => url.includes("/lokacija/"))).toHaveLength(
      2,
    );
  } finally {
    await sync.stop();
    clock.mockRestore();
  }
});

test("hourly reconciliation and live updates cannot overwrite each other's cache writes", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const db = database();
  const net = liveNetwork();
  let release = () => {};
  let entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = (async (input: string | URL | Request) => {
    if (String(input) === feedUrl) {
      entered();
      await blocked;
    }
    return net.request(input);
  }) as typeof fetch;
  const sync = new SpinSync(db.db, feedUrl, () => {}, cachePath, request);
  try {
    const hourly = sync.run();
    await loading;
    const live = sync.refresh(["472569"]);
    expect(net.calls.some((url) => url.includes("/lokacija/"))).toBe(false);
    release();
    await Promise.all([hourly, live]);
    expect((await cached()).map((event) => event.id)).toEqual(["472569"]);
    expect(sync.events[0]?.id).toBe("472569");
  } finally {
    release();
    await sync.stop();
    clock.mockRestore();
  }
});
