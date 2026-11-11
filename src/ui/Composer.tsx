"use client";

import { useEffect, useRef, useState } from "react";
import { IconArrowUp, IconStop } from "./icons";

type Props = {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hero?: boolean;
};

export function Composer({ busy, onSend, onStop, hero = false }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  return (
    <form
      className="rounded-3xl border border-rule bg-surface px-4 pb-2.5 pt-3 shadow-[0_10px_40px_rgb(0_0_0/0.35)] transition-colors focus-within:border-[#3d3d3d] motion-reduce:transition-none"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onClick={() => ref.current?.focus()}
    >
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={hero ? 2 : 1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={hero ? "Ask anything. I'll search the web and remember the answer." : "Ask a follow-up, or what changed since we last talked"}
        className="block max-h-[220px] w-full resize-none bg-transparent px-1 text-[0.97rem] leading-relaxed text-ink outline-none placeholder:text-faint focus:outline-none focus-visible:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="pl-1 text-xs text-faint">
          <span className="hidden sm:inline">Enter to send, Shift + Enter for a new line</span>
        </span>
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop the answer"
            className="flex h-8 items-center gap-2 rounded-full border border-rule px-3 text-xs font-medium text-ink hover:bg-raised"
          >
            <IconStop /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!text.trim()}
            aria-label="Send"
            className="flex size-8 items-center justify-center rounded-full bg-ink text-paper hover:bg-white disabled:bg-raised disabled:text-faint"
          >
            <IconArrowUp />
          </button>
        )}
      </div>
    </form>
  );
}
