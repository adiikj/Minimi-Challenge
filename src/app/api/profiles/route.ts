import { z } from "zod";
import { profileCookie } from "@/identity/resolve";
import { badRequest, sessionPayload, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(40) });

export function POST(req: Request) {
  return withIdentity(req, async ({ app, identity, cookieOpts }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("A profile needs a name (1–40 characters).");

    const profile = app.repo.createProfile(identity.deviceId, parsed.data.name, { tz: identity.profile.tz });
    const next = { ...identity, profile, scope: { userId: profile.id } };
    const res = Response.json(sessionPayload(app, next), { status: 201 });
    res.headers.append("Set-Cookie", profileCookie(profile.id, cookieOpts));
    return res;
  });
}
