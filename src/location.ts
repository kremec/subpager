import { HttpError, type ConvexClient, type ConvexWorker } from "./convex";
import type { Config } from "./config";
import type { Store } from "./store";
import { isObject } from "./radio/decoder";

interface StreamEvent {
  type: string;
  delta?: string;
  text?: string;
  response?: { status: string };
  item?: { content?: { type: string }[] };
}

export function parseLocation(text: string, message: string): string | null {
  const value: unknown = JSON.parse(text);
  if (
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    !(
      value.location === null ||
      (typeof value.location === "string" &&
        value.location.trim() === value.location &&
        value.location.length > 0 &&
        message.includes(value.location))
    )
  )
    throw new Error("Location output is not an exact source substring or null");
  return value.location;
}

export async function readLocationResponse(
  response: Response,
): Promise<string> {
  if (!response.body) throw new Error("Missing extraction response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let doneText: string | undefined;
  let completed = false;
  let refused = false;
  let bytes = 0;
  const accept = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event: StreamEvent = JSON.parse(data);
    if (event.type === "response.output_text.delta")
      output += event.delta ?? "";
    if (event.type === "response.output_text.done") doneText = event.text;
    if (
      event.type.startsWith("response.refusal.") ||
      event.item?.content?.some((part) => part.type === "refusal")
    )
      refused = true;
    if (
      event.type === "response.completed" &&
      event.response?.status === "completed"
    )
      completed = true;
    if (
      ["error", "response.failed", "response.incomplete"].includes(event.type)
    )
      throw new Error("Extraction response failed or incomplete");
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_000_000 || output.length > 10_000)
        throw new Error("Extraction response exceeds size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) accept(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) accept(buffer);
    if (
      !completed ||
      refused ||
      (doneText !== undefined && doneText !== output)
    )
      throw new Error("Extraction stream did not complete consistently");
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class LocationExtractor {
  constructor(
    private instructions: string,
    private model = "gpt-6-luna",
    private transport: (
      url: string,
      options: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  static async open(config: NonNullable<Config["location"]>) {
    const instructions = await Bun.file(
      new URL("./location-instructions.txt", import.meta.url),
    ).text();
    return new LocationExtractor(instructions, config.model);
  }

  async extract(message: string) {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) throw new HttpError(401, "OpenAI credential");
    const response = await this.transport(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              role: "developer",
              content: [{ type: "input_text", text: this.instructions }],
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: JSON.stringify({ message }) },
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
          stream: true,
        }),
        signal: AbortSignal.timeout(40_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, "OpenAI");
    }
    return parseLocation(await readLocationResponse(response), message);
  }
}

interface LocationJob {
  id: number;
  content: string;
  state: "pending" | "ready";
  location: string | null;
  attempts: number;
}

export class LocationWorker {
  lastError: string | null = null;
  private busy = false;
  private inferenceRetryAt = 0;
  private uploadRetryAt = 0;

  constructor(
    private store: Store,
    private extractor: Pick<LocationExtractor, "extract">,
    private client: ConvexClient,
    private cloud: ConvexWorker,
  ) {
    const blocked = this.store.db
      .query<
        {
          inferenceRetryAt: number | null;
          uploadRetryAt: number | null;
        },
        []
      >(`
      SELECT max(CASE WHEN error LIKE 'OpenAI%' THEN next_attempt END) AS inferenceRetryAt,
        max(CASE WHEN error LIKE 'Convex%' THEN next_attempt END) AS uploadRetryAt
      FROM location_jobs
      WHERE error LIKE '% HTTP 401' OR error LIKE '% HTTP 403' OR error LIKE '% HTTP 429'
    `)
      .get();
    this.inferenceRetryAt = blocked?.inferenceRetryAt ?? 0;
    this.uploadRetryAt = blocked?.uploadRetryAt ?? 0;
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    const job = this.store.db
      .query<LocationJob, [number, number, number, number, number, number]>(`
      SELECT m.id, m.content, j.state, j.location, j.attempts
      FROM location_jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.next_attempt <= ? AND
        ((j.state = 'pending' AND ? >= ?) OR
         (j.state = 'ready' AND m.id <= ? AND ? >= ?))
      ORDER BY CASE j.state WHEN 'ready' THEN 0 ELSE 1 END, m.id LIMIT 1
    `)
      .get(
        now,
        now,
        this.inferenceRetryAt,
        this.cloud.cursor,
        now,
        this.uploadRetryAt,
      );
    if (!job) return;
    this.busy = true;
    const startedAt = Date.now();
    try {
      if (job.state === "pending") {
        const location = await this.extractor.extract(job.content);
        this.store.db
          .query(
            "UPDATE location_jobs SET state = 'ready', location = ?, attempts = 0, error = NULL WHERE message_id = ?",
          )
          .run(location, job.id);
      } else {
        await this.client.setLocation(job.id, job.location);
        this.store.db
          .query(
            "UPDATE location_jobs SET state = 'uploaded', attempts = 0, error = NULL WHERE message_id = ?",
          )
          .run(job.id);
      }
      this.lastError = null;
      if (job.state === "pending") this.inferenceRetryAt = 0;
      else this.uploadRetryAt = 0;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Location extraction failed";
      this.lastError = message;
      const permanent =
        (error instanceof HttpError && [400, 404].includes(error.status)) ||
        (job.state === "pending" &&
          job.attempts >= 4 &&
          !(
            error instanceof HttpError && [401, 403, 429].includes(error.status)
          ));
      const accountBlocked =
        error instanceof HttpError && [401, 403, 429].includes(error.status);
      const delay = accountBlocked
        ? 3_600_000
        : Math.min(300_000, 15_000 * 2 ** Math.min(job.attempts, 5));
      const retryAt = now + Math.max(0, Date.now() - startedAt) + delay;
      this.store.db
        .query(
          "UPDATE location_jobs SET state = ?, attempts = attempts + ?, next_attempt = ?, error = ? WHERE message_id = ?",
        )
        .run(
          permanent ? "failed" : job.state,
          accountBlocked ? 0 : 1,
          retryAt,
          message,
          job.id,
        );
      if (accountBlocked) {
        if (job.state === "pending") this.inferenceRetryAt = retryAt;
        else this.uploadRetryAt = retryAt;
      }
    } finally {
      this.busy = false;
    }
  }
}
