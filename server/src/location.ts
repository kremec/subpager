import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { isObject } from "./radio/decoder";
import { createErrorReporter } from "./log";

export interface LocationJob {
  active: boolean;
  state: "pending" | "ready" | "done" | "failed";
  messageId: string;
  content: string;
  nextAttempt: number;
  attempts: number;
  failures: number;
  leaseUntil: number;
  result?: string | null;
  lastError?: string;
}

interface ClaimedLocation extends LocationJob {
  id: string;
}
interface CachedLocation {
  job: ClaimedLocation;
  result: string | null;
}
type HttpRequest = (url: string, options: RequestInit) => Promise<Response>;

const instructions = Bun.file(
  new URL("./location-instructions.txt", import.meta.url),
).text();

class OpenAIError extends Error {
  constructor(readonly status: number) {
    super(`OpenAI HTTP ${status}`);
  }
}

export function parseLocation(text: string, content: string): string | null {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    !(
      value.location === null ||
      (typeof value.location === "string" &&
        value.location.length > 0 &&
        value.location.trim() === value.location &&
        content.includes(value.location))
    )
  )
    throw new Error("Location is not an exact source substring or null");
  return value.location;
}

export function readLocationResponse(payload: unknown): string {
  if (
    !isObject(payload) ||
    payload.status !== "completed" ||
    !Array.isArray(payload.output)
  )
    throw new Error("Location response did not complete");
  const texts: string[] = [];
  for (const item of payload.output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObject(part)) throw new Error("Invalid location output");
      if (part.type === "refusal")
        throw new Error("Location extraction refused");
      if (part.type === "output_text" && typeof part.text === "string")
        texts.push(part.text);
    }
  }
  if (texts.length !== 1) throw new Error("Expected one location result");
  return texts[0]!;
}

export function locationRetry(
  failures: number,
  status?: number,
  now = Date.now(),
) {
  const blocked = status !== undefined && [401, 403, 429].includes(status);
  const count = failures + (blocked ? 0 : 1);
  return {
    failures: count,
    active: status !== 400 && (blocked || count < 5),
    nextAttempt:
      now +
      (blocked
        ? 3_600_000
        : Math.min(300_000, 15_000 * 2 ** Math.min(count - 1, 5))),
  };
}

export class LocationExtraction {
  pausedUntil = 0;
  private results = new Map<string, CachedLocation>();
  private report = createErrorReporter("Location extraction");

  constructor(
    private db: Firestore,
    private key?: string,
    private model = "gpt-6-luna",
    private request: HttpRequest = fetch,
  ) {}

  private async claim(id: string): Promise<ClaimedLocation | null> {
    const ref = this.db.collection("locationJobs").doc(id);
    return this.db.runTransaction(async (tx) => {
      const job = (await tx.get(ref)).data() as LocationJob | undefined;
      const now = Date.now();
      if (
        !job?.active ||
        job.nextAttempt > now ||
        job.leaseUntil > now ||
        (job.state === "pending" && this.pausedUntil > now)
      )
        return null;
      if (job.state === "pending" && job.leaseUntil > 0) {
        const retry = locationRetry(job.failures);
        tx.update(ref, {
          ...retry,
          state: retry.active ? "pending" : "failed",
          leaseUntil: 0,
          lastError: "Location worker did not finish before its lease expired",
        });
        return null;
      }
      const claimed = {
        ...job,
        id,
        attempts: job.attempts + 1,
        leaseUntil: now + 60_000,
      };
      tx.update(ref, {
        attempts: claimed.attempts,
        leaseUntil: claimed.leaseUntil,
      });
      return claimed;
    });
  }

  private async fail(job: ClaimedLocation, error: string, status?: number) {
    this.report(error);
    const retry = locationRetry(job.failures, status);
    if (status !== undefined && [401, 403, 429].includes(status))
      this.pausedUntil = retry.nextAttempt;
    const ref = this.db.collection("locationJobs").doc(job.id);
    await this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as LocationJob | undefined;
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
      const ref = this.db.collection("locationJobs").doc(id);
      await this.db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data() as LocationJob | undefined;
        if (!current?.active || current.attempts !== cached.job.attempts)
          return;
        tx.update(ref, {
          state: "ready",
          result: cached.result,
          leaseUntil: 0,
          nextAttempt: Date.now(),
        });
      });
      this.results.delete(id);
    }
  }

  private async publish(job: ClaimedLocation) {
    const jobRef = this.db.collection("locationJobs").doc(job.id);
    await this.db.runTransaction(async (tx) => {
      const current = (await tx.get(jobRef)).data() as LocationJob | undefined;
      if (
        !current?.active ||
        current.state !== "ready" ||
        current.attempts !== job.attempts
      )
        return;
      const messageRef = this.db.collection("messages").doc(job.messageId);
      const [message, repeats] = await Promise.all([
        tx.get(messageRef),
        tx.get(
          this.db
            .collection("messages")
            .where("duplicateOf", "==", job.messageId),
        ),
      ]);
      if (!message.exists)
        throw new Error("Location destination message is missing");
      parseLocation(JSON.stringify({ location: current.result }), job.content);
      const patch = {
        location: current.result,
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.update(messageRef, patch);
      for (const repeated of repeats.docs) tx.update(repeated.ref, patch);
      tx.delete(jobRef);
    });
  }

  private async extract(job: ClaimedLocation) {
    if (!this.key) {
      await this.fail(job, "OpenAI API key is not configured", 401);
      return;
    }
    let result: string | null;
    try {
      const response = await this.request(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            input: [
              {
                role: "developer",
                content: [{ type: "input_text", text: await instructions }],
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: JSON.stringify({ message: job.content }),
                  },
                ],
              },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "pager_location_source",
                strict: true,
                schema: {
                  type: "object",
                  properties: { location: { type: ["string", "null"] } },
                  required: ["location"],
                  additionalProperties: false,
                },
              },
            },
            reasoning: { effort: "none" },
            store: false,
          }),
          signal: AbortSignal.timeout(40_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenAIError(response.status);
      }
      result = parseLocation(
        readLocationResponse(await response.json()),
        job.content,
      );
    } catch (error) {
      await this.fail(
        job,
        error instanceof Error ? error.message : "Location extraction failed",
        error instanceof OpenAIError ? error.status : undefined,
      );
      return;
    }
    // A failed Firestore write retries this cached paid result, never inference.
    this.results.set(job.id, { job, result });
    await this.saveResults();
    this.report(null);
  }

  async run(ids: string[]) {
    await this.saveResults();
    // Ready results are published even while new inference is paused for quota.
    for (const id of ids) {
      const job = await this.claim(id);
      if (!job) continue;
      if (job.state === "ready") await this.publish(job);
      else await this.extract(job);
      // Yield between jobs so shutdown never drains a backlog of paid requests.
      break;
    }
  }
}
