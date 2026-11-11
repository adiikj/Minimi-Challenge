import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SourceRef } from "@/core/types";
import { linkCitations } from "@/lib/citations";

export function Markdown({ text, sources = [] }: { text: string; sources?: SourceRef[] }) {
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const linked = useMemo(() => linkCitations(text, new Set(byId.keys())), [text, byId]);

  return (
    <div className="answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const source = href?.startsWith("#cite-") ? byId.get(href.slice(6)) : undefined;
            if (source) {
              return (
                <a
                  className="cite"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${source.title} (${source.domain}${source.publishedAt ? `, ${source.publishedAt}` : ""})`}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {linked}
      </ReactMarkdown>
    </div>
  );
}
