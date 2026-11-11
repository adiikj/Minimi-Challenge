import { profileCookie } from "@/identity/resolve";
import { seedDemo } from "@/memory/seed";
import { sessionPayload, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return withIdentity(req, ({ app, identity, cookieOpts }) => {
    const { profileId } = seedDemo(app.repo, { now: app.chat.clock.now(), tz: identity.profile.tz });
    const profile = app.repo.getProfile(profileId)!;
    const next = { ...identity, profile: { id: profile.id, name: profile.name, isDemo: true, tz: profile.tz }, scope: { userId: profile.id } };
    const res = Response.json(sessionPayload(app, next));
    res.headers.append("Set-Cookie", profileCookie(profile.id, cookieOpts));
    return res;
  });
}
