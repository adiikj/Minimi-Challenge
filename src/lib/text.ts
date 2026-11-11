export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary + 1) : cut).trimEnd()} …`;
}
