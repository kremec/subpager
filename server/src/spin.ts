import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import type { PagerReception } from "./firebase";
import { locationRetry } from "./location";
import { createErrorReporter, logInfo } from "./log";
import { hasSpinReport, publicSpinEvent, type SpinEvent } from "./spin-feed";

import { geocodeSpinAddress, type SpinAddress } from "./spin-geocode";
import {
  requestSpinMatch,
  SpinMatchError,
  type SpinDecision,
} from "./spin-match";

export const SPIN_MATCHING_HORIZON = 3 * 86_400_000;

export async function unlinkSpinEvent(db: Firestore, messageId: string) {
  return db.runTransaction(async (tx) => {
    const rootRef = db.collection("messages").doc(messageId);
    const root = await tx.get(rootRef);
    if (!root.exists) throw new Error("Pager message not found");
    if (root.get("deleted") === true) return false;
    const eventId = root.get("spinEventId");
    if (typeof eventId !== "string") return false;
    const links = await tx.get(
      db.collection("messages").where("spinEventId", "==", eventId),
    );
    const rejected = root.get("spinRejectedEventIds");
    tx.update(rootRef, {
      spinEventId: FieldValue.delete(),
      spinMatchStatus: FieldValue.delete(),
      spinRejectedEventIds: [
        ...new Set([...(Array.isArray(rejected) ? rejected : []), eventId]),
      ],
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (
      !links.docs.some(
        (link) => link.id !== messageId && link.get("deleted") !== true,
      )
    )
      tx.delete(db.collection("spinEvents").doc(eventId));
    const expiresAt =
      Date.parse(root.get("receptions")?.at(-1)?.time) + SPIN_MATCHING_HORIZON;
    const jobRef = db.collection("spinJobs").doc(messageId);
    if (expiresAt > Date.now())
      tx.set(jobRef, {
        active: true,
        state: "pending",
        expiresAt,
        nextAttempt: Date.now(),
        attempts: 0,
        failures: 0,
        leaseUntil: 0,
      });
    else tx.delete(jobRef);
    return true;
  });
}

export interface SpinJob {
  active: boolean;
  state: "pending" | "waiting" | "ready" | "failed";
  expiresAt: number;
  nextAttempt: number;
  attempts: number;
  failures: number;
  leaseUntil: number;
  checkedRevision?: string;
  result?: SpinEvent;
  reviewEventId?: string;
  reviewStatus?: SpinDecision["currentLinkStatus"];
  reviewAfterPublish?: boolean;
  lastError?: string;
}
interface ClaimedSpin extends SpinJob {
  id: string;
  content: string;
  receivedAt: string;
  location?: string;
  locationAddress?: string;
  currentLinkId?: string;
  rejectedEventIds: string[];
  rics: number[];
}
interface Catalog {
  ready: boolean;
  revision: string;
  events: SpinEvent[];
}

export class SpinMatching {
  pausedUntil = 0;
  private results = new Map<
    string,
    {
      job: ClaimedSpin;
      result: SpinEvent | null;
      revision: string;
      decision: SpinDecision;
    }
  >();
  private report = createErrorReporter("SPIN matching");
  private addresses = new Map<string, SpinAddress[]>();
  constructor(
    private db: Firestore,
    private catalog: Catalog,
    private key?: string,
    private model = "gpt-6-luna",
    private request: (
      url: string,
      options: RequestInit,
    ) => Promise<Response> = fetch,
    private geocode = geocodeSpinAddress,
  ) {}

  canRun(job: { state: string; checkedRevision?: string; expiresAt?: number }) {
    return (
      job.state === "ready" ||
      (job.expiresAt !== undefined && job.expiresAt <= Date.now()) ||
      (this.catalog.ready &&
        this.catalog.events.length > 0 &&
        (job.state !== "waiting" ||
          job.checkedRevision !== this.catalog.revision))
    );
  }

  // Seed only the recent matching horizon, never scan the entire history.
  async seed() {
    const cutoff = Date.now() - SPIN_MATCHING_HORIZON;
    const messages = await this.db
      .collection("messages")
      .where("updatedAt", ">=", Timestamp.fromMillis(cutoff))
      .get();
    for (const message of messages.docs) {
      const data = message.data();
      if (
        data.deleted === true ||
        (data.spinEventId && data.spinMatchStatus !== "provisional") ||
        data.type === "tone" ||
        !data.content ||
        !(
          Date.parse(data.receptions?.at(-1)?.time) + SPIN_MATCHING_HORIZON >
          Date.now()
        )
      )
        continue;
      const ref = this.db.collection("spinJobs").doc(message.id);
      await this.db.runTransaction(async (tx) => {
        const [job, current] = await Promise.all([
          tx.get(ref),
          tx.get(message.ref),
        ]);
        const data = current.data();
        const expiresAt =
          Date.parse(data?.receptions?.at(-1)?.time) + SPIN_MATCHING_HORIZON;
        if (
          job.exists ||
          !data ||
          (data.spinEventId && data.spinMatchStatus !== "provisional") ||
          data.deleted === true ||
          data.type === "tone" ||
          !data.content ||
          !(expiresAt > Date.now())
        )
          return;
        tx.create(ref, {
          active: true,
          state: "pending",
          expiresAt,
          nextAttempt: Date.now(),
          attempts: 0,
          failures: 0,
          leaseUntil: 0,
          ...(data.spinEventId ? { reviewEventId: data.spinEventId } : {}),
        });
      });
    }
  }

  async review(eventId: string) {
    const messages = await this.db
      .collection("messages")
      .where("spinEventId", "==", eventId)
      .get();
    for (const message of messages.docs) {
      const data = message.data();
      if (
        data.deleted === true ||
        !(
          Date.parse(data.receptions?.at(-1)?.time) + SPIN_MATCHING_HORIZON >
          Date.now()
        )
      )
        continue;
      const ref = this.db.collection("spinJobs").doc(message.id);
      await this.db.runTransaction(async (tx) => {
        const [job, current] = await Promise.all([
          tx.get(ref),
          tx.get(message.ref),
        ]);
        const expiresAt =
          Date.parse(current.get("receptions")?.at(-1)?.time) +
          SPIN_MATCHING_HORIZON;
        if (
          current.get("spinEventId") !== eventId ||
          current.get("deleted") === true ||
          !(expiresAt > Date.now())
        )
          return;
        tx.set(ref, {
          active: true,
          state: "waiting",
          reviewEventId: eventId,
          checkedRevision: this.catalog.revision,
          expiresAt,
          nextAttempt: Date.now(),
          attempts: (job.get("attempts") ?? 0) + 1,
          failures: 0,
          leaseUntil: 0,
        });
      });
    }
  }

  private async claim(id: string): Promise<ClaimedSpin | null> {
    const ref = this.db.collection("spinJobs").doc(id);
    return this.db.runTransaction(async (tx) => {
      const job = (await tx.get(ref)).data() as SpinJob | undefined;
      const now = Date.now();
      if (!job?.active || job.leaseUntil > now) return null;
      if (job.state !== "ready" && job.expiresAt <= now) {
        tx.delete(ref);
        return null;
      }
      if (
        !job.active ||
        job.nextAttempt > now ||
        job.leaseUntil > now ||
        !this.canRun(job) ||
        (job.state !== "ready" && this.pausedUntil > now)
      )
        return null;
      if (job.state !== "ready" && job.leaseUntil > 0) {
        const retry = locationRetry(job.failures);
        tx.update(ref, {
          ...retry,
          state: retry.active ? "pending" : "failed",
          leaseUntil: 0,
          lastError: "SPIN worker did not finish before its lease expired",
        });
        return null;
      }
      const message = await tx.get(this.db.collection("messages").doc(id));
      const data = message.data();
      const receptions: PagerReception[] = Array.isArray(data?.receptions)
        ? data.receptions.filter(
            (reception: PagerReception) =>
              Number.isSafeInteger(reception?.ric) &&
              typeof reception.time === "string" &&
              Number.isFinite(Date.parse(reception.time)),
          )
        : [];
      const receivedAt = receptions.at(-1)?.time;
      if (
        !data ||
        (data.spinEventId && data.spinEventId !== job.reviewEventId) ||
        (job.reviewEventId && data.spinEventId !== job.reviewEventId) ||
        data.deleted === true ||
        data.type === "tone" ||
        typeof data.content !== "string" ||
        !data.content ||
        !receivedAt
      ) {
        tx.delete(ref);
        return null;
      }
      if (
        job.state !== "ready" &&
        Date.parse(receivedAt) + SPIN_MATCHING_HORIZON <= now
      ) {
        tx.delete(ref);
        return null;
      }
      const claimed = {
        ...job,
        id,
        content: data.content,
        receivedAt,
        ...(typeof data.spinEventId === "string"
          ? { currentLinkId: data.spinEventId }
          : {}),
        rejectedEventIds: Array.isArray(data.spinRejectedEventIds)
          ? data.spinRejectedEventIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
        rics: [...new Set(receptions.map((reception) => reception.ric))],
        attempts: job.attempts + 1,
        leaseUntil: now + 60_000,
        ...(typeof data.location === "string"
          ? { location: data.location }
          : {}),
        ...(typeof data.locationAddress === "string"
          ? { locationAddress: data.locationAddress }
          : {}),
      };
      tx.update(ref, {
        attempts: claimed.attempts,
        leaseUntil: claimed.leaseUntil,
      });
      return claimed;
    });
  }

  private async fail(job: ClaimedSpin, error: string, status?: number) {
    this.report(error);
    const retry = locationRetry(job.failures, status);
    if (status !== undefined && [401, 403, 429].includes(status))
      this.pausedUntil = retry.nextAttempt;
    const ref = this.db.collection("spinJobs").doc(job.id);
    await this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as SpinJob | undefined;
      if (!current?.active || current.attempts !== job.attempts) return;
      tx.update(ref, {
        ...retry,
        state: retry.active ? "pending" : "failed",
        leaseUntil: 0,
        lastError: error,
      });
    });
  }

  private async saveResults() {
    for (const [id, cached] of this.results) {
      const ref = this.db.collection("spinJobs").doc(id);
      await this.db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data() as SpinJob | undefined;
        if (!current?.active || current.attempts !== cached.job.attempts)
          return;
        tx.update(ref, {
          state:
            cached.result !== null ||
            cached.decision.currentLinkStatus === "invalid"
              ? "ready"
              : "waiting",
          result: cached.result ?? FieldValue.delete(),
          checkedRevision: cached.revision,
          reviewStatus: cached.decision.currentLinkStatus,
          reviewAfterPublish:
            current.state === "ready" && current.reviewAfterPublish
              ? true
              : FieldValue.delete(),
          failures: 0,
          leaseUntil: 0,
          nextAttempt: Date.now(),
          lastError: FieldValue.delete(),
        });
      });
      this.results.delete(id);
    }
  }

  private async publish(job: ClaimedSpin) {
    const ref = this.db.collection("spinJobs").doc(job.id);
    await this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as SpinJob | undefined;
      if (
        !current?.active ||
        current.state !== "ready" ||
        current.attempts !== job.attempts
      )
        return;
      if (
        !current.result &&
        !(job.currentLinkId && current.reviewStatus === "invalid")
      )
        throw new Error("Missing SPIN match report");
      const messageRef = this.db.collection("messages").doc(job.id);
      const message = await tx.get(messageRef);
      if (
        !message.exists ||
        message.get("deleted") === true ||
        (message.get("spinEventId") ?? undefined) !== job.currentLinkId
      ) {
        tx.delete(ref);
        return;
      }
      const eventRef = current.result
        ? this.db.collection("spinEvents").doc(current.result.id)
        : undefined;
      const event = eventRef ? await tx.get(eventRef) : undefined;
      const oldId = job.currentLinkId;
      const changed = oldId !== current.result?.id;
      const otherLinks =
        oldId && changed
          ? await tx.get(
              this.db.collection("messages").where("spinEventId", "==", oldId),
            )
          : undefined;
      if (
        current.expiresAt > Date.now() &&
        current.checkedRevision !== undefined &&
        this.catalog.ready &&
        this.catalog.revision &&
        current.checkedRevision !== this.catalog.revision
      ) {
        tx.update(ref, {
          state: "waiting",
          result: FieldValue.delete(),
          reviewStatus: FieldValue.delete(),
          leaseUntil: 0,
          nextAttempt: Date.now(),
        });
        return;
      }
      if (eventRef && current.result && !event?.exists)
        tx.create(eventRef, {
          ...publicSpinEvent(current.result),
          updatedAt: FieldValue.serverTimestamp(),
        });
      else if (
        eventRef &&
        event?.exists &&
        current.result &&
        hasSpinReport(current.result) &&
        !hasSpinReport({ ...event.data(), id: event.id } as SpinEvent)
      )
        tx.update(eventRef, {
          ...publicSpinEvent(current.result),
          updatedAt: FieldValue.serverTimestamp(),
        });
      const status =
        current.result && !hasSpinReport(current.result)
          ? "provisional"
          : "confirmed";
      const rejected = message.get("spinRejectedEventIds");
      tx.update(messageRef, {
        spinEventId: current.result?.id ?? FieldValue.delete(),
        spinMatchStatus: current.result ? status : FieldValue.delete(),
        ...(oldId && changed
          ? {
              spinRejectedEventIds: [
                ...new Set([
                  ...(Array.isArray(rejected) ? rejected : []),
                  oldId,
                ]),
              ],
            }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (
        otherLinks &&
        !otherLinks.docs.some(
          (link) => link.id !== job.id && link.get("deleted") !== true,
        )
      )
        tx.delete(this.db.collection("spinEvents").doc(oldId!));
      if (current.reviewAfterPublish && current.expiresAt > Date.now())
        tx.update(ref, {
          state: "pending",
          reviewEventId: current.result?.id ?? FieldValue.delete(),
          result: FieldValue.delete(),
          reviewStatus: FieldValue.delete(),
          checkedRevision: FieldValue.delete(),
          reviewAfterPublish: FieldValue.delete(),
          leaseUntil: 0,
          nextAttempt: Date.now(),
        });
      else if (
        current.result &&
        current.expiresAt > Date.now() &&
        (status === "provisional" ||
          (current.checkedRevision !== undefined &&
            current.checkedRevision !== this.catalog.revision))
      )
        tx.update(ref, {
          state: "waiting",
          reviewEventId: current.result.id,
          checkedRevision: current.checkedRevision ?? "",
          result: FieldValue.delete(),
          reviewStatus: FieldValue.delete(),
          leaseUntil: 0,
        });
      else if (!current.result && oldId) {
        tx.update(ref, {
          state: "pending",
          reviewEventId: FieldValue.delete(),
          result: FieldValue.delete(),
          reviewStatus: FieldValue.delete(),
          leaseUntil: 0,
          nextAttempt: Date.now(),
        });
      } else tx.delete(ref);
    });
  }

  private async match(job: ClaimedSpin) {
    if (!this.key) {
      await this.fail(job, "OpenAI API key is not configured", 401);
      return;
    }
    const revision = this.catalog.revision;
    const events = this.catalog.events.filter(
      (event) => !job.rejectedEventIds.includes(event.id),
    );
    const startedAt = performance.now();
    let decision: SpinDecision;
    try {
      let addresses: SpinAddress[] = [];
      const addressLocation = job.locationAddress ?? job.location;
      if (addressLocation && events.some((event) => !hasSpinReport(event))) {
        const cached = this.addresses.get(addressLocation);
        addresses = cached ?? (await this.geocode(addressLocation));
        if (!cached && addresses.length) {
          if (this.addresses.size >= 200)
            this.addresses.delete(this.addresses.keys().next().value!);
          this.addresses.set(addressLocation, addresses);
        }
      }
      const units = await Promise.all(
        job.rics.map((ric) =>
          this.db.collection("ricUnits").doc(String(ric)).get(),
        ),
      );
      const unitName = [
        ...new Set(
          units.flatMap((unit) => {
            const name = unit.get("unitName");
            return typeof name === "string" ? [name] : [];
          }),
        ),
      ].join(", ");
      decision = await requestSpinMatch(
        { ...job, ...(unitName ? { unitName } : {}) },
        events,
        addresses,
        this.key,
        this.model,
        this.request,
      );
      logInfo(
        `OpenAI SPIN result for call ${job.id}; model=${this.model}; durationMs=${Math.round(performance.now() - startedAt)}; result=${JSON.stringify(decision)}`,
      );
    } catch (error) {
      await this.fail(
        job,
        error instanceof Error ? error.message : "SPIN matching failed",
        error instanceof SpinMatchError ? error.status : undefined,
      );
      return;
    }
    this.results.set(job.id, {
      job,
      result:
        decision.incidentId === null
          ? null
          : publicSpinEvent(
              events.find((event) => event.id === decision.incidentId)!,
            ),
      revision,
      decision,
    });
    await this.saveResults();
    this.report(null);
  }

  async run(ids: string[]) {
    await this.saveResults();
    for (const id of ids) {
      const job = await this.claim(id);
      if (!job) continue;
      if (job.state === "ready") await this.publish(job);
      else await this.match(job);
      break;
    }
  }
}
