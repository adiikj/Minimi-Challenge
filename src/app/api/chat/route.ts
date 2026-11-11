import { z } from "zod";
import { runChatTurn } from "@/agent/chat-turn";
import { sseResponse } from "@/lib/sse";
import { badRequest, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    threadId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(8000),
    clientTz: z.string().max(64).default("UTC"),
    recheckOf: z.string().uuid().optional(),
  })
  .refine((b) => !b.recheckOf || b.threadId, { message: "recheckOf needs the threadId of that answer" });

export function POST(req: Request) {
  return withIdentity(req, async ({ app, identity }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");

    const controller = new AbortController();
    req.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const events = runChatTurn({ scope: identity.scope, ...parsed.data }, app.chat, controller.signal);
    return sseResponse(events, () => controller.abort());
  });
}
