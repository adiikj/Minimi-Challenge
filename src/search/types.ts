export type SearchKind = "general" | "news";
export type SearchDepth = "fast" | "thorough";

export type SearchQuery = {
  q: string;
  since?: string;
  domains?: string[];
  kind?: SearchKind;
};

export type RawResult = {
  url: string;
  title: string;
  content: string;
  score: number;
  publishedAt?: string;
};

export type ProviderResponse = { results: RawResult[]; credits: number };

export interface SearchProvider {
  readonly name: string;
  search(q: SearchQuery, depth: SearchDepth, signal: AbortSignal): Promise<ProviderResponse>;
}

export interface PageReader {
  read(url: string, signal: AbortSignal): Promise<string>;
}

export type Source = {
  id: string;
  url: string;
  domain: string;
  title: string;
  publishedAt?: string;
  retrievedAt: string;
  excerpt: string;
};

export type QueryOutcome = {
  query: SearchQuery;
  status: "ok" | "cached" | "timeout" | "error";
  results: number;
  ms: number;
  error?: string;
};

export type SearchRun = {
  sources: Array<Source & { isNew: boolean }>;
  outcomes: QueryOutcome[];
  credits: number;
};
