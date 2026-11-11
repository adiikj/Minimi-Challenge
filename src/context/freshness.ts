import { daysBetween, type Ymd } from "@/lib/dates";
import type { StoredClaim } from "@/memory/repo";


export type FreshnessLevel = "fresh" | "stale" | "changed";

export type Freshness = {
  level: FreshnessLevel;
  facts: number;
  changed: number;
  changedFoundOn: Ymd | null;
  checkedOn: Ymd | null;
  ageDays: number | null;
  staleKind: "prices" | "versions" | "facts" | null;
  staleFacts: number;
  staleSince: Ymd | null;
};

const PRICE = /price|pricing|cost|fee|seat|per user|month|annual|plan|tier|free|trial|limit|quota|storage|credit|discount/i;
const VERSION = /version|release|model|launch|feature|api|deprecat|support/i;

export function shelfLifeDays(attribute: string, plan?: string | null): { days: number; kind: NonNullable<Freshness["staleKind"]> } {
  if (plan || PRICE.test(attribute)) return { days: 7, kind: "prices" };
  if (VERSION.test(attribute)) return { days: 14, kind: "versions" };
  return { days: 30, kind: "facts" };
}

export const lastChecked = (c: Pick<StoredClaim, "observedAt" | "confirmedAt">): Ymd =>
  c.confirmedAt && c.confirmedAt > c.observedAt ? c.confirmedAt : c.observedAt;

export function freshness(claims: StoredClaim[], today: Ymd): Freshness | null {
  if (claims.length === 0) return null;
  const changedClaims = claims.filter((c) => c.supersededBy);
  const live = claims.filter((c) => !c.supersededBy);

  let checkedOn: Ymd | null = null;
  let staleKind: Freshness["staleKind"] = null;
  let staleFacts = 0;
  let staleSince: Ymd | null = null;
  const rank = { prices: 3, versions: 2, facts: 1 } as const;
  for (const c of live) {
    const d = lastChecked(c);
    if (!checkedOn || d < checkedOn) checkedOn = d;
    const shelf = shelfLifeDays(c.attribute, c.plan);
    if (daysBetween(d, today) > shelf.days) {
      staleFacts++;
      if (!staleSince || d < staleSince) staleSince = d;
      if (!staleKind || rank[shelf.kind] > rank[staleKind]) staleKind = shelf.kind;
    }
  }
  const changedFoundOn = changedClaims.map((c) => c.supersededBy!.observedAt).sort().at(-1) ?? null;

  return {
    level: changedClaims.length ? "changed" : staleKind ? "stale" : "fresh",
    facts: claims.length,
    changed: changedClaims.length,
    changedFoundOn,
    checkedOn,
    ageDays: checkedOn ? Math.max(0, daysBetween(checkedOn, today)) : null,
    staleKind,
    staleFacts,
    staleSince,
  };
}

export function threadNeedsRecheck(claims: StoredClaim[], today: Ymd): boolean {
  return claims.some((c) => !c.supersededBy && daysBetween(lastChecked(c), today) > shelfLifeDays(c.attribute, c.plan).days);
}
