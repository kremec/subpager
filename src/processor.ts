import type { Firestore } from "firebase-admin/firestore";
import { PushDelivery, type PushJob } from "./delivery";
import { LocationExtraction, type LocationJob } from "./location";
import { createErrorReporter } from "./log";
import { FirestoreUsers } from "./users";

export interface ProcessorOptions {
  openaiApiKey?: string;
  expoAccessToken?: string;
  model?: string;
}

interface ScheduledJob {
  id: string;
  state: string;
  nextAttempt: number;
  leaseUntil: number;
  lastError?: string;
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
    private collection: "pushJobs" | "locationJobs",
    private execute: (ids: string[]) => Promise<void>,
    private pausedUntil: () => number = () => 0,
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
          this.connected = true;
          this.jobs = snapshot.docs.map((doc) => {
            const job = doc.data() as PushJob | LocationJob;
            return {
              id: doc.id,
              state: job.state,
              nextAttempt: job.nextAttempt,
              leaseUntil: job.leaseUntil,
              lastError: job.lastError,
            };
          });
          this.schedule();
        },
        () => {
          this.connected = false;
          this.report("Job listener disconnected; reconnecting in 30 seconds");
          this.unsubscribe?.();
          if (!this.stopped) {
            clearTimeout(this.timer);
            this.reconnectTimer = setTimeout(() => this.start(), 30_000);
          }
        },
      );
  }

  private due(job: ScheduledJob) {
    const persistedPause =
      this.collection === "locationJobs"
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
      job.state === "pending"
        ? Math.max(this.pausedUntil(), persistedPause)
        : 0,
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
    this.timer = setTimeout(
      () => this.run(),
      Math.min(2_147_483_647, Math.max(0, next - Date.now())),
    );
  }

  private run() {
    const due = this.jobs.filter((job) => this.due(job) <= Date.now());
    if (this.collection === "locationJobs")
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
  }

  start() {
    void this.users.ready().catch(() => {});
    for (const queue of this.queues) queue.start();
  }
  async stop() {
    this.users.stop();
    await Promise.all(this.queues.map((queue) => queue.stop()));
  }
}
