import { DatabaseSync } from "node:sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(content); INSERT INTO probe VALUES ('postgres hosting');");
    const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    const hit = db.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH 'postgres'").get() as { n: number };
    return Response.json({ ok: true, node: process.version, sqlite: version.v, fts5: hit.n === 1 });
  } finally {
    db.close();
  }
}
