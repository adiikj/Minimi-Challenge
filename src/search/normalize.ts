export function sanitizeQuery(q: string): string {
  return q
    .replace(/[$€£₹]\s?\d[\d.,]*(\s*(?:\/|per)\s*\w+)?/gi, " ")
    .replace(/\b\d[\d.,]*\s?(?:usd|eur|dollars?)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function domainOf(urlOrDomain: string): string {
  const s = urlOrDomain.trim().toLowerCase();
  try {
    const host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return s.replace(/^www\./, "").split("/")[0] ?? s;
  }
}

export function matchesDomain(domain: string, preferred: string): boolean {
  const p = domainOf(preferred);
  return domain === p || domain.endsWith(`.${p}`);
}

const TRACKING_PARAMS = /^(utm_|ref$|ref_|fbclid$|gclid$|mc_)/i;

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host}${path === "/" ? "" : path}${u.search}`;
  } catch {
    return url.trim();
  }
}

export function toIsoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

export function cleanText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export { truncate } from "@/lib/text";
import { truncate } from "@/lib/text";

const PRICE_LINE = /[$€£₹]\s?\d|\b(price|pricing|plan|per (month|user|seat|year)|\/mo\b|\/month|monthly|annual|free|pro|team|business|enterprise|starter|seat|tier|usage|included|limit)\b/i;

export function extractRelevant(page: string, max: number): string {
  const lines = cleanText(page).split("\n").map((l) => l.trim());
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!line) return;
    if (/^#{1,4}\s/.test(line) || PRICE_LINE.test(line)) {
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i + 1 < lines.length) keep.add(i + 1);
    }
  });
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]).filter(Boolean);
  return truncate(picked.join("\n"), max);
}
