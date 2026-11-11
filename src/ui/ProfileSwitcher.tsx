"use client";

import { useEffect, useRef, useState } from "react";
import type { ProfileSummary } from "./api";
import { IconChevronsUpDown } from "./icons";

type Props = {
  active: ProfileSummary;
  profiles: ProfileSummary[];
  onSwitch: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLoadDemo: () => Promise<void>;
};

type Mode = { kind: "menu" } | { kind: "create" } | { kind: "rename" } | { kind: "confirm-delete" };

export function ProfileSwitcher({ active, profiles, onSwitch, onCreate, onRename, onDelete, onLoadDemo }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "menu" });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setMode({ kind: "menu" });
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const own = profiles.filter((p) => !p.isDemo);
  const demos = profiles.filter((p) => p.isDemo);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-surface ${open ? "bg-surface" : ""}`}
      >
        <Initial name={active.name} demo={active.isDemo} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{active.name}</span>
          <span className="block text-[0.72rem] text-faint">{active.isDemo ? "Demo profile, sample history" : "Your profile"}</span>
        </span>
        <span className="text-faint">
          <IconChevronsUpDown />
        </span>
      </button>

      {open && (
        <div className="absolute inset-x-0 bottom-full z-30 mb-1.5 rounded-2xl border border-rule bg-surface p-1.5 text-sm shadow-[0_-12px_40px_rgb(0_0_0/0.5)]" role="menu">
          {mode.kind === "menu" && (
            <>
              <Group label="On this browser">
                {own.map((p) => (
                  <ProfileItem key={p.id} p={p} active={p.id === active.id} onPick={() => run(() => onSwitch(p.id))} />
                ))}
              </Group>
              {demos.length > 0 && (
                <Group label="Demo profiles">
                  {demos.map((p) => (
                    <ProfileItem key={p.id} p={p} active={p.id === active.id} onPick={() => run(() => onSwitch(p.id))} />
                  ))}
                </Group>
              )}
              <div className="my-1.5 h-px bg-rule" />
              <MenuButton onClick={() => (setName(""), setMode({ kind: "create" }))}>New profile</MenuButton>
              {(demos.length === 0 || active.isDemo) && (
                <MenuButton onClick={() => void run(onLoadDemo)}>
                  {active.isDemo ? "Reset demo history" : "Load demo history"}
                  <span className="block text-[0.75rem] text-faint">
                    {active.isDemo ? "Restores the sample conversations, dated from today." : "A profile with sample past conversations to try memory."}
                  </span>
                </MenuButton>
              )}
              {!active.isDemo && (
                <>
                  <MenuButton onClick={() => (setName(active.name), setMode({ kind: "rename" }))}>Rename “{active.name}”</MenuButton>
                  <MenuButton tone="alert" onClick={() => setMode({ kind: "confirm-delete" })}>
                    Delete “{active.name}”…
                  </MenuButton>
                </>
              )}
            </>
          )}

          {(mode.kind === "create" || mode.kind === "rename") && (
            <form
              className="space-y-2.5 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = name.trim();
                if (n) void run(() => (mode.kind === "create" ? onCreate(n) : onRename(active.id, n)));
              }}
            >
              <label className="block text-graphite" htmlFor="profile-name">
                {mode.kind === "create" ? "Name the new profile" : "Rename this profile"}
              </label>
              <input
                id="profile-name"
                autoFocus
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-ink outline-none focus:border-faint"
              />
              <FormButtons pending={pending} submit={mode.kind === "create" ? "Create and switch" : "Save name"} onCancel={() => setMode({ kind: "menu" })} />
            </form>
          )}

          {mode.kind === "confirm-delete" && (
            <div className="space-y-2.5 p-2">
              <p className="text-ink">Delete “{active.name}” and everything it remembers?</p>
              <p className="text-[0.8rem] text-graphite">Its conversations and stored facts can’t be recovered.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void run(() => onDelete(active.id))}
                  className="rounded-lg border border-alert/40 px-3 py-1.5 font-medium text-alert hover:bg-alert/10 disabled:opacity-50"
                >
                  Delete profile
                </button>
                <button type="button" onClick={() => setMode({ kind: "menu" })} className="rounded-lg px-3 py-1.5 text-graphite hover:bg-raised hover:text-ink">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <p className="px-2 pb-1 text-alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Initial({ name, demo }: { name: string; demo: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[0.75rem] font-semibold ${
        demo ? "border border-dashed border-faint text-graphite" : "bg-raised text-ink"
      }`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-0.5">
      <p className="px-2 pb-1 pt-1.5 text-[0.72rem] font-medium text-faint">{label}</p>
      {children}
    </div>
  );
}

function ProfileItem({ p, active, onPick }: { p: ProfileSummary; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={active ? undefined : onPick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${active ? "bg-raised" : "hover:bg-raised"}`}
    >
      <Initial name={p.name} demo={p.isDemo} />
      <span className="min-w-0 flex-1 truncate text-ink">{p.name}</span>
      {active && <span className="text-xs text-faint">Active</span>}
    </button>
  );
}

function MenuButton({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone?: "alert" }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full break-words rounded-lg px-2 py-1.5 text-left hover:bg-raised ${tone === "alert" ? "text-alert" : "text-ink"}`}
    >
      {children}
    </button>
  );
}

function FormButtons({ pending, submit, onCancel }: { pending: boolean; submit: string; onCancel: () => void }) {
  return (
    <div className="flex gap-2">
      <button type="submit" disabled={pending} className="rounded-lg bg-ink px-3 py-1.5 font-medium text-paper disabled:opacity-50">
        {submit}
      </button>
      <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-graphite hover:bg-raised hover:text-ink">
        Cancel
      </button>
    </div>
  );
}
