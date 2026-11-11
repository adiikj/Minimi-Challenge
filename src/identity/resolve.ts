import type { UserScope } from "@/core/types";
import type { Profile, Repo } from "@/memory/repo";
import { DEVICE_COOKIE, parseCookies, PROFILE_COOKIE, serializeCookie, sign, verify } from "./cookies";

export type Identity = { deviceId: string; profile: Profile; scope: UserScope };
export type IdentityResult = { identity: Identity; setCookies: string[] };
export type IdentityOptions = { secret: string; secure: boolean; tz?: string };

export function resolveIdentity(repo: Repo, cookieHeader: string | null, opts: IdentityOptions): IdentityResult {
  const cookies = parseCookies(cookieHeader);
  const setCookies: string[] = [];

  let deviceId = verify(opts.secret, DEVICE_COOKIE, cookies[DEVICE_COOKIE]);
  if (!deviceId || !repo.deviceExists(deviceId)) {
    deviceId = repo.createDevice();
    setCookies.push(serializeCookie(DEVICE_COOKIE, sign(opts.secret, DEVICE_COOKIE, deviceId), opts));
  }

  const requested = verify(opts.secret, PROFILE_COOKIE, cookies[PROFILE_COOKIE]);
  const candidate = requested ? repo.getProfile(requested) : undefined;
  let profile: Profile | undefined = candidate && canUse(candidate, deviceId) ? candidate : undefined;

  if (!profile) {
    profile = defaultProfile(repo, deviceId, opts.tz);
    setCookies.push(profileCookie(profile.id, opts));
  }
  const { id, name, isDemo, tz } = profile;
  return { identity: { deviceId, profile: { id, name, isDemo, tz }, scope: { userId: id } }, setCookies };
}

export function switchProfile(repo: Repo, deviceId: string, profileId: string, opts: IdentityOptions): string | undefined {
  const p = repo.getProfile(profileId);
  return p && canUse(p, deviceId) ? profileCookie(p.id, opts) : undefined;
}

export function profileCookie(profileId: string, opts: IdentityOptions): string {
  return serializeCookie(PROFILE_COOKIE, sign(opts.secret, PROFILE_COOKIE, profileId), opts);
}

const canUse = (p: { deviceId: string | null; isDemo: boolean }, deviceId: string) => p.isDemo || p.deviceId === deviceId;

export function defaultProfile(repo: Repo, deviceId: string, tz?: string): Profile {
  const own = repo.listProfiles(deviceId).find((p) => !p.isDemo);
  return own ?? repo.createProfile(deviceId, "You", tz ? { tz } : {});
}
