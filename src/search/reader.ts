import type { PageReader } from "./types";

export function createJinaReader(opts: { fetchImpl?: typeof fetch } = {}): PageReader {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async read(url, signal) {
      const res = await doFetch(`https://r.jina.ai/${url}`, { headers: { Accept: "text/plain" }, signal });
      if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
      return res.text();
    },
  };
}
