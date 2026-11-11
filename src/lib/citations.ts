export const CITATION_RE = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g;

export function findCitations(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    for (const id of m[1]!.split(/\s*[,;]\s*/)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function checkCitations(text: string, validIds: ReadonlySet<string>): { used: string[]; invalid: string[] } {
  const all = findCitations(text);
  return { used: all.filter((id) => validIds.has(id)), invalid: all.filter((id) => !validIds.has(id)) };
}

export const stripCitations = (text: string) => text.replace(CITATION_RE, "").replace(/[ \t]+([.,;:!?)])/g, "$1");

export function linkCitations(text: string, validIds: ReadonlySet<string>): string {
  return text.replace(CITATION_RE, (_, group: string) =>
    group
      .split(/\s*[,;]\s*/)
      .filter((id) => validIds.has(id))
      .map((id) => `[${id.slice(1)}](#cite-${id})`)
      .join(""),
  );
}
