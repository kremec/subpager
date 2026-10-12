import type { Firestore } from "firebase-admin/firestore";
import type { RadioState } from "./radio";
import { FirestoreUsers } from "./users";
import { logInfo } from "./log";

interface ReceptionHealth {
  outageSince: number | null;
  notified: boolean;
  pushJobIds: string[];
}

// Silence between pager calls is normal. Check incoming audio, not pager traffic.
export class ReceptionMonitor {
  private healthy?: boolean;
  private notified = false;
  private running?: Promise<void>;

  constructor(
    private db: Firestore,
    private users: FirestoreUsers,
  ) {}

  check(radio: RadioState, now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    const healthy =
      radio.state === "running" &&
      radio.lastAudioAt !== null &&
      now - Date.parse(radio.lastAudioAt) < 30_000;
    if (healthy === this.healthy && (healthy || this.notified))
      return Promise.resolve();
    this.running = this.update(healthy, radio.error, now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async update(healthy: boolean, error: string | null, now: number) {
    await this.users.ready();
    const recipients = this.users.recipients("downtime");
    const ref = this.db.collection("receiverHealth").doc("main");
    const result = await this.db.runTransaction(async (tx) => {
      const previous = (await tx.get(ref)).data() as
        | ReceptionHealth
        | undefined;
      if (healthy) {
        const ids = previous?.pushJobIds ?? [];
        const jobs = ids.length
          ? await tx.getAll(
              ...ids.map((id) => this.db.collection("pushJobs").doc(id)),
            )
          : [];
        // Expire unsent alerts; accepted Expo tickets still retain their receipts.
        for (const job of jobs)
          if (job.exists) tx.update(job.ref, { expiresAt: now });
        tx.set(ref, { outageSince: null, notified: false, pushJobIds: [] });
        return { notified: false, queued: false };
      }
      const outageSince = previous?.outageSince ?? now;
      const notified = previous?.notified ?? false;
      if (notified) return { notified: true, queued: false };
      const pushJobIds: string[] = [];
      if (now - outageSince >= 120_000 && recipients.length) {
        for (let offset = 0; offset < recipients.length; offset += 100) {
          const id = `reception-down-${outageSince}-${offset}`;
          pushJobIds.push(id);
          tx.create(this.db.collection("pushJobs").doc(id), {
            kind: "downtime",
            active: true,
            state: "pending",
            title: "Subpager reception is down",
            body: "No radio audio for at least 2 minutes. The receiver is retrying automatically. Check the USB receiver.",
            recipients: recipients.slice(offset, offset + 100),
            expiresAt: now + 300_000,
            nextAttempt: now,
            attempts: 0,
            leaseUntil: 0,
          });
        }
      }
      tx.set(ref, {
        outageSince,
        notified: pushJobIds.length > 0,
        pushJobIds,
        error,
      });
      return { notified: pushJobIds.length > 0, queued: pushJobIds.length > 0 };
    });
    if (result.queued) logInfo("Reception downtime notification queued");
    this.healthy = healthy;
    this.notified = result.notified;
  }
}
