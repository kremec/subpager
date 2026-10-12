import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { createErrorReporter, logInfo } from "./log";
import { isObject } from "./radio/decoder";
import { SPIN_MATCHING_HORIZON } from "./spin";
import {
  hasSpinReport,
  parseSpinDetail,
  parseSpinFeed,
  publicSpinEvent,
  spinReportedAtUtc,
  type SpinEvent,
} from "./spin-feed";

const hour = 3_600_000;
const retry = 300_000;

interface StoredEvent extends SpinEvent {
  nextDetailAt: number;
  rssRevision?: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SpinSync {
  private archived = new Map<string, StoredEvent>();
  private municipalities = new Set<string>();
  private loaded = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private operations = Promise.resolve();
  private notices = new Map<string, number>();
  private pending = new Map<string, number>();
  private pendingLoaded = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeAt = 0;
  private flushingNotices = false;
  private liveDirty = false;
  private recoveryRequested = false;
  private abort = new AbortController();
  private report = createErrorReporter("SPIN sync");
  private candidateEvents: SpinEvent[] = [];
  revision = "";
  ready = false;

  constructor(
    private db: Firestore,
    private url: string,
    private onChange: () => void,
    private cachePath: string,
    private request: typeof fetch = fetch,
    private onReportChanged: (id: string) => Promise<void> = async () => {},
  ) {}

  get events(): SpinEvent[] {
    return this.candidateEvents;
  }

  start(): void {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.running = this.run()
      .then(() => {
        this.report(null);
        if (!this.stopped) this.timer = setTimeout(() => this.start(), hour);
      })
      .catch((error) => {
        if (this.stopped) return;
        this.report(error instanceof Error ? error.message : String(error));
        this.timer = setTimeout(() => this.start(), retry);
      })
      .finally(() => {
        this.running = undefined;
        if (this.recoveryRequested) this.start();
      });
  }

  recover(): void {
    if (this.stopped) return;
    this.recoveryRequested = true;
    this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.noticeTimer);
    this.abort.abort();
    await this.operations;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(async () => {
      if (!this.stopped) await operation();
    });
    this.operations = next.catch(() => {});
    return next;
  }

  notify(id: string): void {
    if (
      this.stopped ||
      !/^[1-9]\d*$/.test(id) ||
      !Number.isSafeInteger(Number(id))
    )
      return;
    if (!this.notices.has(id)) this.notices.set(id, 0);
    this.scheduleNotices(1000);
  }

  private scheduleNotices(delay: number): void {
    if (this.stopped || this.flushingNotices || !this.notices.size) return;
    const at = Date.now() + delay;
    if (this.noticeTimer && at >= this.noticeAt) return;
    clearTimeout(this.noticeTimer);
    this.noticeAt = at;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.flushingNotices = true;
      const batch = this.notices;
      this.notices = new Map();
      void this.refresh([...batch.keys()])
        .then((unavailable) => {
          for (const id of unavailable) {
            const attempt = batch.get(id)!;
            if (attempt < 2 && !this.notices.has(id))
              this.notices.set(id, attempt + 1);
          }
          this.report(null);
        })
        .catch((error) => {
          if (this.stopped) return;
          this.report(error instanceof Error ? error.message : String(error));
          for (const [id, attempt] of batch)
            if (
              this.pending.has(id) &&
              this.pending.get(id)! > Date.now() &&
              !this.notices.has(id)
            )
              this.notices.set(id, attempt + 1);
        })
        .finally(() => {
          this.flushingNotices = false;
          this.scheduleNotices(
            [...this.notices.values()].some((attempt) => attempt > 2)
              ? retry
              : 5000,
          );
        });
    }, delay);
  }

  // Serialize public reads and cache writes with hourly reconciliation.
  async refresh(ids: string[]): Promise<string[]> {
    const unavailable: string[] = [];
    await this.enqueue(async () => {
      await this.loadPending();
      const batch = [...new Set(ids)].filter(
        (id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)),
      );
      for (const id of batch)
        if (!this.pending.has(id))
          this.pending.set(id, Date.now() + SPIN_MATCHING_HORIZON);
      await this.persistPending();
      if (!this.loaded) await this.load();
      let failure: unknown;
      for (const id of batch) {
        try {
          const response = await this.get(
            `https://spin3.sos112.si/api/javno/lokacija/${id}`,
          );
          const fields = parseSpinDetail(await response.json());
          const previous = this.archived.get(id);
          if (!fields.reportedAtLocal || !fields.municipality) {
            unavailable.push(id);
            continue;
          }
          const eventAt =
            previous?.eventAt ?? spinReportedAtUtc(fields.reportedAtLocal);
          if (Date.parse(eventAt) < Date.now() - SPIN_MATCHING_HORIZON)
            continue;
          const event = {
            id,
            title: previous?.title ?? "SPIN",
            eventAt,
            ...previous,
            ...fields,
            description:
              fields.description ??
              (previous && hasSpinReport(previous, this.municipalities)
                ? previous.description
                : fields.municipality),
          };
          if (
            previous &&
            hash(publicSpinEvent(previous)) === hash(publicSpinEvent(event))
          )
            continue;
          this.archived.set(id, {
            ...event,
            nextDetailAt: this.nextDetail(event),
          });
          this.liveDirty = true;
          logInfo(
            `SPIN public update: incidentId=${id}; narrative=${hasSpinReport(event, this.municipalities)}`,
          );
        } catch (error) {
          unavailable.push(id);
          failure = error;
        }
      }
      if (this.liveDirty) {
        await this.persist();
        if (this.stopped) return;
        await this.updateConfirmed();
        this.publish();
        this.liveDirty = false;
      }
      if (failure) throw failure;
      for (const id of batch) this.pending.delete(id);
      await this.persistPending();
    });
    return unavailable;
  }

  private async get(url: string): Promise<Response> {
    const response = await this.request(url, {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error(`SPIN HTTP ${response.status}`);
    return response;
  }

  private async load(): Promise<void> {
    await this.loadPending();
    const response = await this.get(
      "https://spin3.sos112.si/api/javno/odObmocje",
    );
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("value" in payload) ||
      !Array.isArray(payload.value)
    ) {
      throw new Error("Invalid SPIN municipality catalog");
    }
    const municipalities = new Set<string>();
    for (const region of payload.value) {
      if (
        !region ||
        typeof region !== "object" ||
        !Array.isArray(region.items)
      ) {
        throw new Error("Invalid SPIN municipality catalog");
      }
      for (const municipality of region.items) {
        if (
          !municipality ||
          typeof municipality.naziv !== "string" ||
          !municipality.naziv.trim()
        ) {
          throw new Error("Invalid SPIN municipality catalog");
        }
        municipalities.add(municipality.naziv.trim());
      }
    }
    if (!municipalities.size)
      throw new Error("Empty SPIN municipality catalog");
    let events: unknown = [];
    try {
      events = JSON.parse(await readFile(this.cachePath, "utf8"));
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(events)) throw new Error("Invalid SPIN candidate cache");
    const archived = new Map<string, StoredEvent>();
    for (const event of events) {
      if (
        !isObject(event) ||
        typeof event.id !== "string" ||
        !/^\d+$/.test(event.id) ||
        archived.has(event.id) ||
        typeof event.title !== "string" ||
        typeof event.description !== "string" ||
        typeof event.eventAt !== "string" ||
        !Number.isFinite(Date.parse(event.eventAt)) ||
        typeof event.nextDetailAt !== "number" ||
        !Number.isFinite(event.nextDetailAt) ||
        event.nextDetailAt < 0 ||
        (event.rssRevision !== undefined &&
          typeof event.rssRevision !== "string")
      )
        throw new Error("Invalid SPIN candidate cache");
      if (
        !event.municipality &&
        typeof event.description === "string" &&
        municipalities.has(event.description.trim())
      )
        event.municipality = event.description.trim();
      archived.set(event.id, event as unknown as StoredEvent);
    }
    this.archived = archived;
    this.municipalities = municipalities;
    this.loaded = true;
  }

  private async loadPending(): Promise<void> {
    if (this.pendingLoaded) return;
    let pending: unknown = [];
    try {
      pending = JSON.parse(await readFile(`${this.cachePath}.pending`, "utf8"));
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(pending)) throw new Error("Invalid SPIN pending cache");
    for (const entry of pending) {
      if (
        !isObject(entry) ||
        typeof entry.id !== "string" ||
        !/^[1-9]\d*$/.test(entry.id) ||
        !Number.isSafeInteger(Number(entry.id)) ||
        typeof entry.expiresAt !== "number" ||
        !Number.isFinite(entry.expiresAt)
      )
        throw new Error("Invalid SPIN pending cache");
      if (entry.expiresAt > Date.now()) {
        this.pending.set(entry.id, entry.expiresAt);
        this.notices.set(entry.id, 3);
      }
    }
    this.pendingLoaded = true;
    this.scheduleNotices(5000);
  }

  private publish(): void {
    const events = [...this.archived.values()]
      .filter(
        (event) =>
          hasSpinReport(event, this.municipalities) ||
          (event.latitude !== undefined &&
            event.longitude !== undefined &&
            !!event.municipality),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(publicSpinEvent);
    const revision = hash(
      events.map(
        ({
          id,
          title,
          description,
          eventAt,
          category,
          municipality,
          reportedAtLocal,
          latitude,
          longitude,
        }) => ({
          id,
          title,
          description,
          eventAt,
          category,
          municipality,
          reportedAtLocal,
          latitude,
          longitude,
        }),
      ),
    );
    this.candidateEvents = events;
    this.revision = revision;
    this.ready = true;
    this.onChange();
  }

  private prune(): void {
    const cutoff = Date.now() - SPIN_MATCHING_HORIZON;
    for (const [id, event] of this.archived) {
      if (Date.parse(event.eventAt) < cutoff) this.archived.delete(id);
    }
  }

  private async persist(): Promise<void> {
    this.prune();
    await this.persistFile(this.cachePath, [...this.archived.values()]);
  }

  private async persistPending(): Promise<void> {
    for (const [id, expiresAt] of this.pending)
      if (expiresAt <= Date.now()) this.pending.delete(id);
    await this.persistFile(
      `${this.cachePath}.pending`,
      [...this.pending].map(([id, expiresAt]) => ({ id, expiresAt })),
    );
  }

  private async persistFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }

  private async updateConfirmed(): Promise<void> {
    const snapshot = await this.db
      .collection("spinEvents")
      .where(
        "eventAt",
        ">=",
        new Date(Date.now() - SPIN_MATCHING_HORIZON).toISOString(),
      )
      .get();
    for (const doc of snapshot.docs) {
      const event = this.archived.get(doc.id);
      if (
        !event ||
        (hasSpinReport(
          { ...doc.data(), id: doc.id } as SpinEvent,
          this.municipalities,
        ) &&
          !hasSpinReport(event, this.municipalities))
      )
        continue;
      const report = publicSpinEvent(event);
      if (
        hash(report) ===
        hash(publicSpinEvent({ ...doc.data(), id: doc.id } as SpinEvent))
      )
        continue;
      await this.onReportChanged(doc.id);
      // update never creates a missing document, including after a concurrent deletion.
      await doc.ref.update({
        ...report,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  private nextDetail(event: SpinEvent): number {
    const now = Date.now();
    const occurred = Date.parse(event.eventAt);
    if (now >= occurred + 48 * hour) return 0;
    if (!hasSpinReport(event, this.municipalities))
      return Math.min(now + hour, occurred + 48 * hour);
    return now < occurred + 24 * hour
      ? occurred + 24 * hour
      : occurred + 48 * hour;
  }

  run(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    let fetched = false;
    let publishable = false;
    try {
      if (!this.loaded) await this.load();
      this.prune();
      if (this.recoveryRequested) {
        this.recoveryRequested = false;
        for (const event of this.archived.values())
          event.nextDetailAt = Date.now();
      }
      const response = await this.get(this.url);
      const items = parseSpinFeed(await response.text());
      fetched = true;
      const now = Date.now();
      for (const item of items) {
        if (Date.parse(item.eventAt) < now - SPIN_MATCHING_HORIZON) continue;
        const previous = this.archived.get(item.id);
        const rssRevision = hash(item);
        if (previous?.rssRevision === rssRevision) continue;
        const event = { ...previous, ...item, rssRevision, nextDetailAt: now };
        if (
          !event.municipality &&
          this.municipalities.has(item.description.trim())
        )
          event.municipality = item.description.trim();
        if (
          previous &&
          hasSpinReport(previous, this.municipalities) &&
          !hasSpinReport(item, this.municipalities)
        ) {
          event.description = previous.description;
        }
        this.archived.set(event.id, event);
      }
      let failure: unknown;
      for (const event of this.archived.values()) {
        if (!event.nextDetailAt || event.nextDetailAt > now) continue;
        try {
          const detail = await this.get(
            `https://spin3.sos112.si/api/javno/lokacija/${event.id}`,
          );
          const fields = parseSpinDetail(await detail.json());
          const enriched = { ...event, ...fields };
          if (
            !fields.description &&
            fields.municipality &&
            !hasSpinReport(event, this.municipalities)
          )
            enriched.description = fields.municipality;
          if (
            hasSpinReport(event, this.municipalities) &&
            !hasSpinReport(enriched, this.municipalities)
          ) {
            enriched.description = event.description;
          }
          this.archived.set(event.id, {
            ...enriched,
            nextDetailAt: this.nextDetail(enriched),
          });
        } catch (error) {
          if (this.stopped) throw error;
          failure = error;
          this.archived.set(event.id, {
            ...event,
            nextDetailAt: Date.now() + retry,
          });
        }
      }
      if (failure) throw failure;
    } finally {
      try {
        if (this.loaded) {
          await this.persist();
          if (!this.stopped) {
            if (fetched) this.ready = true;
            if (this.ready) await this.updateConfirmed();
          }
          publishable = true;
        }
      } finally {
        if (!this.stopped) {
          if (publishable && this.ready) {
            this.publish();
            this.liveDirty = false;
          } else this.onChange();
        }
      }
    }
  }
}
