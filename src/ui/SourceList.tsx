"use client";

import { useState } from "react";
import type { SourceRef } from "@/core/types";
import { findCitations } from "@/lib/citations";

export function SourceList({ sources, answer }: { sources: SourceRef[]; answer: string }) {
  const [showAll, setShowAll] = useState(false);
  if (sources.length === 0) return null;
  const citedIds = new Set(findCitations(answer));
  const cited = sources.filter((s) => citedIds.has(s.id));
  const others = sources.filter((s) => !citedIds.has(s.id));
  const visible = cited.length === 0 || showAll ? [...cited, ...others] : cited;
  const hidden = cited.length === 0 ? 0 : others.length;

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs text-faint">{cited.length ? "Sources" : "Sources read"}</p>
      <ul className="flex flex-wrap gap-1.5">
        {visible.map((s) => (
          <li key={s.id}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${s.title}\n${s.domain}, ${s.publishedAt ? `published ${s.publishedAt}` : "date not stated"}`}
              className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-rule bg-surface py-1 pl-1 pr-2.5 text-xs hover:border-faint hover:text-ink ${
                citedIds.has(s.id) ? "text-graphite" : "text-faint"
              }`}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-[0.65rem] font-semibold text-graphite">
                {s.id.slice(1)}
              </span>
              <span className="truncate">{s.domain}</span>
            </a>
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="inline-flex items-center rounded-full border border-dashed border-rule px-2.5 py-1 text-xs text-faint hover:border-faint hover:text-graphite"
            >
              {showAll ? "Show fewer" : `+${hidden} more read`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
