import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { locationInstructions } from "./instructions";

const claim = { messageId: v.id("messages"), attempt: v.number() };

interface StreamEvent {
  type: string;
  delta?: string;
  text?: string;
  response?: { status: string };
  item?: { content?: { type: string }[] };
}

export function parseLocation(text: string, content: string): string | null {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("location" in value) ||
    !(
      value.location === null ||
      (typeof value.location === "string" &&
        value.location.trim() === value.location &&
        value.location.length > 0 &&
        content.includes(value.location))
    )
  ) {
    throw new Error("Location is not an exact source substring or null");
  }
  return value.location;
}

export async function readLocationResponse(response: Response) {
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
    const event = JSON.parse(data) as StreamEvent;
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

async function retry(
  ctx: MutationCtx,
  message: Doc<"messages">,
  error: string,
  status?: number,
) {
  const enrichment = message.enrichment;
  if (!enrichment) return;
  const blocked = status !== undefined && [401, 403, 429].includes(status);
  const failures = (enrichment.failures ?? 0) + (blocked ? 0 : 1);
  const permanent = status === 400 || (!blocked && failures >= 5);
  const delay = blocked
    ? 3600000
    : Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5));
  const nextAttempt = Date.now() + delay;
  await ctx.db.patch(message._id, {
    enrichment: {
      ...enrichment,
      state: permanent ? "failed" : "pending",
      nextAttempt,
      failures,
      error,
    },
  });
  if (!permanent)
    await ctx.scheduler.runAt(nextAttempt, internal.location.dispatch, {
      messageId: message._id,
    });
}

export const dispatch = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      message.location !== undefined ||
      message.enrichment?.state !== "pending"
    )
      return;
    const nextAttempt = message.enrichment.nextAttempt;
    if (nextAttempt > Date.now()) {
      await ctx.scheduler.runAt(nextAttempt, internal.location.dispatch, args);
      return;
    }
    const attempt = message.enrichment.attempt + 1;
    await ctx.db.patch(message._id, {
      enrichment: {
        ...message.enrichment,
        state: "running",
        attempt,
        nextAttempt: Date.now() + 60000,
      },
    });
    await ctx.scheduler.runAfter(60000, internal.location.recover, {
      ...args,
      attempt,
    });
    await ctx.scheduler.runAfter(0, internal.location.extract, {
      ...args,
      attempt,
    });
  },
});

export const job = internalQuery({
  args: claim,
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      message.location !== undefined ||
      message.enrichment?.state !== "running" ||
      message.enrichment.attempt !== args.attempt
    )
      return null;
    return { content: message.content };
  },
});

export const begin = internalMutation({
  args: claim,
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      message.location !== undefined ||
      message.enrichment?.state !== "running" ||
      message.enrichment.attempt !== args.attempt
    )
      return null;
    await ctx.db.patch(message._id, {
      enrichment: { ...message.enrichment, nextAttempt: Date.now() + 60000 },
    });
    return { content: message.content };
  },
});

export const failed = internalMutation({
  args: { ...claim, error: v.string(), status: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      message?.location === undefined &&
      message?.enrichment?.state === "running" &&
      message.enrichment.attempt === args.attempt
    )
      await retry(ctx, message, args.error, args.status);
  },
});

export const recover = internalMutation({
  args: claim,
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      message?.location === undefined &&
      message?.enrichment?.state === "running" &&
      message.enrichment.attempt === args.attempt
    ) {
      if (message.enrichment.nextAttempt > Date.now()) {
        await ctx.scheduler.runAt(
          message.enrichment.nextAttempt,
          internal.location.recover,
          args,
        );
        return;
      }
      await retry(ctx, message, "Location action did not finish");
    }
  },
});

export const complete = internalMutation({
  args: { ...claim, location: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      message.enrichment?.state !== "running" ||
      message.enrichment.attempt !== args.attempt ||
      message.location !== undefined
    )
      return;
    parseLocation(JSON.stringify({ location: args.location }), message.content);
    await ctx.db.patch(message._id, {
      location: args.location,
      enrichment: undefined,
    });
    const repeats = await ctx.db
      .query("messages")
      .withIndex("by_duplicate", (q) => q.eq("duplicateOf", message._id))
      .collect();
    for (const repeated of repeats)
      await ctx.db.patch(repeated._id, { location: args.location });
  },
});

export const extract = internalAction({
  args: claim,
  handler: async (ctx, args): Promise<void> => {
    const job: { content: string } | null = await ctx.runMutation(
      internal.location.begin,
      args,
    );
    if (!job) return;
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      await ctx.runMutation(internal.location.failed, {
        ...args,
        error: "OpenAI API key is not configured",
        status: 401,
      });
      return;
    }
    let response: Response;
    let location: string | null;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-6-luna",
          input: [
            {
              role: "developer",
              content: [{ type: "input_text", text: locationInstructions }],
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
          stream: true,
        }),
        signal: AbortSignal.timeout(40000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        await ctx.runMutation(internal.location.failed, {
          ...args,
          error: `OpenAI HTTP ${response.status}`,
          status: response.status,
        });
        return;
      }
      location = parseLocation(
        await readLocationResponse(response),
        job.content,
      );
    } catch (error) {
      await ctx.runMutation(internal.location.failed, {
        ...args,
        error:
          error instanceof Error ? error.message : "Location extraction failed",
      });
      return;
    }
    // Retain the paid result while retrying its write, without another inference.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ctx.runMutation(internal.location.complete, {
          ...args,
          location,
        });
        return;
      } catch {
        if (attempt === 2)
          await ctx.scheduler.runAfter(0, internal.location.complete, {
            ...args,
            location,
          });
      }
    }
  },
});
