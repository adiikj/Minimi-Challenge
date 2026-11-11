import "server-only";
import { ConfigError } from "@/core/errors";
import { resolveIdentity, type Identity } from "@/identity/resolve";
import { threadNeedsRecheck } from "@/context/freshness";
import { localDate } from "@/lib/time";
import { getApp, type App } from "./app";

export async function withIdentity(
  req: Request,
  handler: (ctx: { app: App; identity: Identity; cookieOpts: { secret: string; secure: boolean } }) => Response | Promise<Response>,
): Promise<Response> {
  let app: App;
  try {
    app = getApp();
  } catch (err) {
    if (err instanceof ConfigError) return Response.json({ error: err.message }, { status: 500 });
    throw err;
  }
  const cookieOpts = { secret: app.secret, secure: new URL(req.url).protocol === "https:" };
  const { identity, setCookies } = resolveIdentity(app.repo, req.headers.get("cookie"), cookieOpts);
  const res = await handler({ app, identity, cookieOpts });
  for (const c of setCookies) res.headers.append("Set-Cookie", c);
  return res;
}

export function sessionPayload(app: App, identity: Identity) {
  const { repo } = app;
  const threads = repo.listThreads(identity.scope);
  const today = localDate(app.chat.clock.now(), identity.profile.tz);
  const claims = repo.claimsForThreads(identity.scope, threads.map((t) => t.id));
  return {
    profile: identity.profile,
    profiles: repo.listProfiles(identity.deviceId).map(({ id, name, isDemo }) => ({ id, name, isDemo })),
    threads: threads.map((t) => ({ ...t, needsRecheck: threadNeedsRecheck(claims.filter((c) => c.threadId === t.id), today) })),
  };
}

export type SessionPayload = ReturnType<typeof sessionPayload>;

export const badRequest = (message: string) => Response.json({ error: message }, { status: 400 });
export const notFound = (message = "Not found") => Response.json({ error: message }, { status: 404 });
