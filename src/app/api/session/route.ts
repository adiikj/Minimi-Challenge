import { sessionPayload, withIdentity } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withIdentity(req, ({ app, identity }) => Response.json(sessionPayload(app, identity)));
}
