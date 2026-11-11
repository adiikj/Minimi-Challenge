import { freshness } from "@/context/freshness";
import { localDate } from "@/lib/time";
import { notFound, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withIdentity(req, ({ app, identity }) => {
    const thread = app.repo.getThread(identity.scope, id);
    if (!thread) return notFound("Conversation not found");
    const stored = app.repo.listMessages(identity.scope, id);
    const today = localDate(app.chat.clock.now(), identity.profile.tz);
    const claims = app.repo.claimsForMessages(identity.scope, stored.filter((m) => m.role === "assistant").map((m) => m.id));
    const messages = stored.map(({ sources, ...m }) => ({
      ...m,
      sources: sources.map(({ excerpt: _excerpt, ...s }) => s),
      freshness: m.role === "assistant" ? freshness(claims.filter((c) => c.messageId === m.id), today) : null,
    }));
    return Response.json({ thread, messages, today });
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withIdentity(req, ({ app, identity }) =>
    app.repo.deleteThread(identity.scope, id) ? Response.json({ ok: true }) : notFound("Conversation not found"),
  );
}
