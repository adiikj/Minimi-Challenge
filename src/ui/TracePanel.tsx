import type { TraceSpan, TurnTrace } from "@/core/types";
import { dollars, seconds } from "./format";

export function TracePanel({ trace }: { trace: TurnTrace }) {
  const spans = trace.spans ?? [];
  const end = Math.max(trace.totalMs, ...spans.map((s) => s.startMs + s.ms), 1);
  const u = trace.usage;
  const cacheShare = u.inputTokens ? Math.round((100 * u.cachedInputTokens) / u.inputTokens) : 0;

  return (
    <section className="mt-2 rounded-2xl border border-rule bg-surface px-4 py-3.5 text-xs text-graphite" aria-label="How this answer was made">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[0.8rem] font-medium text-ink">How this answer was made</h3>
        <p className="tabular">
          {seconds(trace.totalMs)} total{trace.firstTokenMs !== null ? `, first words at ${seconds(trace.firstTokenMs)}` : ""}
        </p>
      </header>

      {spans.length ? (
        <>
          <ol className="mt-3 flex flex-col gap-2.5">
            {spans.map((s, i) => (
              <SpanRow key={i} span={s} end={end} />
            ))}
          </ol>
          <Axis end={end} />
        </>
      ) : (
        <p className="mt-2 text-faint">No timeline was recorded for this answer (it predates the trace panel). Totals below.</p>
      )}

      <dl className="mt-3.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-rule pt-3 sm:grid-cols-[auto_1fr_auto_1fr]">
        <Fact term="Model">
          {trace.model}, {trace.rounds} round{trace.rounds === 1 ? "" : "s"}
        </Fact>
        <Fact term="Cost">{dollars(trace.costUsd)}</Fact>
        <Fact term="Tokens">
          {u.inputTokens.toLocaleString()} in ({cacheShare}% cached), {u.outputTokens.toLocaleString()} out
        </Fact>
        <Fact term="Searches">
          {trace.search.queries === 0
            ? "none"
            : `${trace.search.queries} quer${trace.search.queries === 1 ? "y" : "ies"}, ${trace.search.cacheHits} from cache, ${trace.search.credits} credit${trace.search.credits === 1 ? "" : "s"}`}
        </Fact>
        <Fact term="Sources">
          {trace.search.sources} read, {trace.citations.used.length} cited
          {trace.citations.invalid.length ? `, ${trace.citations.invalid.length} invalid citation${trace.citations.invalid.length === 1 ? "" : "s"} removed` : ""}
        </Fact>
        <Fact term="Memory">
          {trace.memory
            ? trace.memory.status === "found"
              ? `${trace.memory.refs.length} past conversation${trace.memory.refs.length === 1 ? "" : "s"} in ${trace.memory.ms} ms`
              : `searched, nothing found (${trace.memory.ms} ms)`
            : "not needed"}
        </Fact>
      </dl>
      {trace.truncated && <p className="mt-2 text-faint">The answer hit its length or round budget and was cut short.</p>}
    </section>
  );
}

const BAR: Record<TraceSpan["kind"], string> = {
  memory: "bg-faint",
  prefetch: "bg-graphite",
  search: "bg-graphite",
  model: "bg-ink",
};

function SpanRow({ span: s, end }: { span: TraceSpan; end: number }) {
  const pct = (ms: number) => `${Math.min(100, (100 * ms) / end)}%`;
  const writingFrom = s.kind === "model" && s.firstTextMs !== undefined ? s.firstTextMs - s.startMs : null;
  const tokens = s.usage ? `${s.usage.inputTokens.toLocaleString()} in, ${s.usage.outputTokens.toLocaleString()} out` : null;
  const detail = s.queries?.length ? `${s.queries.join(", ")}${s.cacheHits ? ` (${s.cacheHits} from cache)` : ""}` : tokens;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)_3.5rem]">
      <div className="min-w-0 sm:row-span-1">
        <p className="truncate text-prose">{s.label}</p>
        {detail && (
          <p className="truncate text-faint" title={detail}>
            {detail}
          </p>
        )}
      </div>
      <p className="tabular text-right sm:order-last">{s.ms < 1000 ? `${s.ms} ms` : seconds(s.ms)}</p>
      <div className="relative col-span-2 h-2 rounded-full bg-raised sm:col-span-1" aria-hidden>
        {writingFrom === null ? (
          <span className={`absolute inset-y-0 rounded-full ${s.kind === "model" ? "bg-[#5c5c5c]" : BAR[s.kind]}`} style={{ left: pct(s.startMs), width: `max(${pct(s.ms)}, 3px)` }} />
        ) : (
          <>
            <span className="absolute inset-y-0 rounded-l-full bg-[#5c5c5c]" style={{ left: pct(s.startMs), width: pct(writingFrom) }} />
            <span
              className="absolute inset-y-0 rounded-r-full bg-ink"
              style={{ left: pct(s.firstTextMs!), width: `max(${pct(s.ms - writingFrom)}, 3px)` }}
            />
          </>
        )}
      </div>
    </li>
  );
}

function Axis({ end }: { end: number }) {
  return (
    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_3.5rem] gap-x-3 text-faint sm:grid-cols-[11rem_minmax(0,1fr)_3.5rem]">
      <p className="hidden sm:block" />
      <p className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1">
        <span className="tabular">0 s</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-full bg-[#5c5c5c]" /> model thinking
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-full bg-ink" /> writing
          </span>
        </span>
        <span className="tabular">{seconds(end)}</span>
      </p>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-faint">{term}</dt>
      <dd className="min-w-0 text-prose">{children}</dd>
    </>
  );
}
