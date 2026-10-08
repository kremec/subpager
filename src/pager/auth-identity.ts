import { Base64 } from "convex/values";

export function authIdentity(token: string | null) {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(
      String.fromCharCode(...Base64.toByteArray(padded)),
    ) as { sub?: string };
    return typeof claims.sub === "string"
      ? claims.sub.split("|")[0] || null
      : null;
  } catch {
    return null;
  }
}
