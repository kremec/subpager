import type { Firestore } from "firebase-admin/firestore";
import { PushDelivery, type PushJob } from "./delivery";
import { LocationExtraction, type LocationJob } from "./location";
import { createErrorReporter, logInfo } from "./log";
import { FirestoreUsers } from "./users";
import { SpinMatching, type SpinJob } from "./spin";
import { SpinSync } from "./spin-sync";

export interface ProcessorOptions {
  openaiApiKey?: string;
  expoAccessToken?: string;
  model?: string;
  spinRssUrl?: string;
  spinCachePath?: string;
}

interface ScheduledJob {
  id: string;
  state: string;
  nextAttempt: number;
  leaseUntil: number;
  lastError?: string;
  checkedRevision?: string;
  expiresAt?: number;
}

// One listener and one due timer per queue. No periodic Firestore reads.
class JobQueue {
  private jobs: ScheduledJob[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private connected = false;
  private retryAt = 0;
  private report: ReturnType<typeof createErrorReporter>;

  constructor(
    private db: Firestore,
    private collection: "pushJobs" | "locationJobs" | "spinJobs",
    private execute: (ids: string[]) => Promise<void>,
    private pausedUntil: () => number = () => 0,
    private canRun: (job: ScheduledJob) => boolean = () => true,
  ) {
    this.report = createErrorReporter(collection);
  }

  start() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.unsubscribe = this.db
      .collection(this.collection)
      .where("active", "==", true)
      .onSnapshot(
        (snapshot) => {
          if (!this.connected) {
            this.report(null);
            logInfo(`${this.collection} listener connected`);
          }
          this.connected = true;
          this.jobs = snapshot.docs.map((doc) => {
            const job = doc.data() as PushJob | LocationJob | SpinJob;
            return {
              id: doc.id,
              state: job.state,
              nextAttempt: job.nextAttempt,
              leaseUntil: job.leaseUntil,
              lastError: job.lastError,
              ...("checkedRevision" in job
                ? { checkedRevision: job.checkedRevision }
                : {}),
              ...("expiresAt" in job ? { expiresAt: job.expiresAt } : {}),
            };
          });
          this.schedule();
        },
        (error) => {
          this.connected = false;
          this.report(
            `Job listener disconnected; reconnecting in 30 seconds: ${error.message}`,
          );
          this.unsubscribe?.();
          if (!this.stopped) {
            clearTimeout(this.timer);
            this.reconnectTimer = setTimeout(() => this.start(), 30_000);
          }
        },
      );
  }

  private due(job: ScheduledJob) {
    if (!this.canRun(job)) return Infinity;
    if (
      this.collection === "spinJobs" &&
      job.state !== "ready" &&
      job.expiresAt !== undefined &&
      job.expiresAt <= Date.now()
    )
      return job.leaseUntil;
    const persistedPause =
      this.collection !== "pushJobs"
        ? Math.max(
            0,
            ...this.jobs
              .filter((candidate) =>
                /^OpenAI HTTP (401|403|429)$|^OpenAI API key is not configured$/.test(
                  candidate.lastError ?? "",
                ),
              )
              .map((candidate) => candidate.nextAttempt),
          )
        : 0;
    return Math.max(
      job.nextAttempt,
      job.leaseUntil,
      job.state !== "ready" ? Math.max(this.pausedUntil(), persistedPause) : 0,
    );
  }

  private schedule() {
    if (this.stopped || !this.connected || this.running) return;
    clearTimeout(this.timer);
    if (!this.jobs.length) return;
    const next = Math.max(
      this.retryAt,
      Math.min(...this.jobs.map((job) => this.due(job))),
    );
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => this.run(),
      Math.min(2_147_483_647, Math.max(0, next - Date.now())),
    );
  }

  reschedule() {
    this.schedule();
  }

  private run() {
    const due = this.jobs.filter((job) => this.due(job) <= Date.now());
    if (this.collection !== "pushJobs")
      due.sort(
        (left, right) =>
          Number(right.state === "ready") - Number(left.state === "ready"),
      );
    const ids = due.map((job) => job.id);
    this.running = this.execute(ids)
      .then(
        () => {
          this.retryAt = 0;
          this.report(null);
        },
        () => {
          this.retryAt = Date.now() + 15_000;
          this.report(
            "Job processing failed; retrying without discarding pending results",
          );
        },
      )
      .finally(() => {
        this.running = undefined;
        this.schedule();
      });
  }

  async stop() {
    this.stopped = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    await this.running;
  }
}

export class FirestoreJobsProcessor {
  private queues: JobQueue[];
  private spin?: SpinSync;
  private seed?: Promise<void>;
  private seedTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private seedSpin?: () => Promise<void>;

  constructor(
    db: Firestore,
    options: ProcessorOptions = {},
    private users = new FirestoreUsers(db),
  ) {
    const push = new PushDelivery(db, fetch, options.expoAccessToken, users);
    const location = new LocationExtraction(
      db,
      options.openaiApiKey,
      options.model,
    );
    this.queues = [
      new JobQueue(db, "pushJobs", (ids) => push.run(ids)),
      new JobQueue(
        db,
        "locationJobs",
        (ids) => location.run(ids),
        () => location.pausedUntil,
      ),
    ];
    if (options.spinRssUrl) {
      let queue: JobQueue;
      let matching: SpinMatching;
      this.spin = new SpinSync(
        db,
        options.spinRssUrl,
        () => queue.reschedule(),
        options.spinCachePath ?? "./data/spin-candidates.json",
        fetch,
        (id) => matching.review(id),
      );
      matching = new SpinMatching(
        db,
        this.spin,
        options.openaiApiKey,
        options.model,
      );
      queue = new JobQueue(
        db,
        "spinJobs",
        (ids) => matching.run(ids),
        () => matching.pausedUntil,
        (job) => matching.canRun(job),
      );
      this.queues.push(queue);
      this.seedSpin = () => matching.seed();
    }
  }

  start() {
    void this.users.ready().catch(() => {});
    for (const queue of this.queues) queue.start();
    this.spin?.start();
    this.seedRecentMessages();
  }
  private seedRecentMessages() {
    if (this.stopped || !this.seedSpin) return;
    this.seed = this.seedSpin().catch(() => {
      if (!this.stopped)
        this.seedTimer = setTimeout(() => this.seedRecentMessages(), 30_000);
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.seedTimer);
    this.users.stop();
    await Promise.all([
      ...this.queues.map((queue) => queue.stop()),
      this.spin?.stop(),
      this.seed,
    ]);
  }
}
