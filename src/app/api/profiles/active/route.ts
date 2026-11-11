import { z } from "zod";
import { switchProfile } from "@/identity/resolve";
import { badRequest, notFound, sessionPayload, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ profileId: z.string().uuid() });

export function POST(req: Request) {
  return withIdentity(req, async ({ app, identity, cookieOpts }) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid profile id");

    const cookie = switchProfile(app.repo, identity.deviceId, parsed.data.profileId, cookieOpts);
    const profile = cookie ? app.repo.getProfile(parsed.data.profileId) : undefined;
    if (!cookie || !profile) return notFound("Profile not found");

    const { id, name, isDemo, tz } = profile;
    const next = { ...identity, profile: { id, name, isDemo, tz }, scope: { userId: id } };
    const res = Response.json(sessionPayload(app, next));
    res.headers.append("Set-Cookie", cookie);
    return res;
  });
}
