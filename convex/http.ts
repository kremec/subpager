import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import type { PagerMessage } from "./validators";

const http = httpRouter();
auth.addHttpRoutes(http);

const receiver = httpAction(async (ctx, request) => {
  const secret = process.env.RECEIVER_SECRET;
  if (!secret)
    return Response.json(
      { error: "Receiver is not configured" },
      { status: 503 },
    );
  if (request.headers.get("authorization") !== `Bearer ${secret}`)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const path = new URL(request.url).pathname;
  try {
    if (path === "/receiver/devices")
      return Response.json(await ctx.runQuery(internal.receiver.devices, {}));
    let body: object;
    try {
      body = (await request.json()) as object;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!body || Array.isArray(body) || typeof body !== "object")
      return Response.json(
        { error: "Expected a JSON object" },
        { status: 400 },
      );
    // Internal function validators check every field before database writes.
    if (path === "/receiver/ingest")
      return Response.json(
        await ctx.runMutation(
          internal.receiver.ingest,
          body as { messages: PagerMessage[]; notify: boolean },
        ),
      );
    if (path === "/receiver/ric-units")
      return Response.json(
        await ctx.runMutation(
          internal.receiver.ricUnits,
          body as { units: { ric: number; unitName: string }[] },
        ),
      );
    return Response.json(
      await ctx.runMutation(
        internal.receiver.members,
        body as { uid: string; approved: boolean },
      ),
    );
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data !== null &&
      "code" in error.data
    ) {
      return Response.json(
        { error: error.data.message },
        { status: error.data.code === "NOT_FOUND" ? 404 : 400 },
      );
    }
    if (
      error instanceof Error &&
      (error.message.includes("ArgumentValidationError") ||
        error.message.startsWith("Validator error:"))
    )
      return Response.json(
        { error: "Invalid request fields" },
        { status: 400 },
      );
    console.error("Receiver request failed", path);
    return Response.json(
      { error: "Receiver operation failed" },
      { status: 500 },
    );
  }
});

for (const path of ["ingest", "ric-units", "members"])
  http.route({ path: `/receiver/${path}`, method: "POST", handler: receiver });
http.route({ path: "/receiver/devices", method: "GET", handler: receiver });
export default http;
