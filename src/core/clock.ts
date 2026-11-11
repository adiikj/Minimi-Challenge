import type { Clock } from "./types";

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date): Clock {
  const ms = at.getTime();
  return { now: () => new Date(ms) };
}

export function clockFor(fixedNow: Date | undefined): Clock {
  return fixedNow ? fixedClock(fixedNow) : systemClock;
}
