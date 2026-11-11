import { z } from "zod";
import { defaultProfile, profileCookie } from "@/identity/resolve";
import { badRequest, notFound, sessionPayload, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ name: z.string().trim().min(1).max(40) });

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withIdentity(req, async ({ app, identity }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("A profile needs a name (1–40 characters).");
    if (!app.repo.renameProfile(identity.deviceId, id, parsed.data.name)) return notFound("Profile not found");
    const profile = identity.profile.id === id ? { ...identity.profile, name: parsed.data.name } : identity.profile;
    return Response.json(sessionPayload(app, { ...identity, profile }));
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withIdentity(req, ({ app, identity, cookieOpts }) => {
    if (!app.repo.deleteProfile(identity.deviceId, id)) return notFound("Profile not found");
    if (identity.profile.id !== id) return Response.json(sessionPayload(app, identity));

    const profile = defaultProfile(app.repo, identity.deviceId, identity.profile.tz);
    const res = Response.json(sessionPayload(app, { ...identity, profile, scope: { userId: profile.id } }));
    res.headers.append("Set-Cookie", profileCookie(profile.id, cookieOpts));
    return res;
  });
}
