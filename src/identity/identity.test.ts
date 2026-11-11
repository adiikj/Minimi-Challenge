import { describe, expect, it } from "vitest";
import { openDb } from "@/memory/db";
import { createRepo } from "@/memory/repo";
import { DEVICE_COOKIE, parseCookies, PROFILE_COOKIE, sign, verify } from "./cookies";
import { resolveIdentity, switchProfile } from "./resolve";

const opts = { secret: "test-secret-0123456789", secure: false };
const setup = () => createRepo(openDb(":memory:"));

const asCookieHeader = (setCookies: string[], existing = "") =>
  [existing, ...setCookies.map((c) => c.split(";")[0])].filter(Boolean).join("; ");

describe("signed cookies", () => {
  it("round-trips and rejects tampering", () => {
    const signed = sign(opts.secret, PROFILE_COOKIE, "abc");
    expect(verify(opts.secret, PROFILE_COOKIE, signed)).toBe("abc");
    expect(verify(opts.secret, PROFILE_COOKIE, signed.replace("abc", "abd"))).toBeUndefined();
    expect(verify("another-secret-000000", PROFILE_COOKIE, signed)).toBeUndefined();
    expect(verify(opts.secret, PROFILE_COOKIE, sign(opts.secret, DEVICE_COOKIE, "abc"))).toBeUndefined();
    expect(verify(opts.secret, PROFILE_COOKIE, "garbage")).toBeUndefined();
  });

  it("parses cookie headers", () => {
    expect(parseCookies("a=1; b=x%3Dy; c")).toEqual({ a: "1", b: "x=y" });
  });
});

describe("resolveIdentity", () => {
  it("first visit: creates a device and a 'You' profile and sets both cookies", () => {
    const repo = setup();
    const { identity, setCookies } = resolveIdentity(repo, null, { ...opts, tz: "Asia/Kolkata" });
    expect(identity.profile).toMatchObject({ name: "You", isDemo: false, tz: "Asia/Kolkata" });
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toMatch(/HttpOnly; SameSite=Lax/);

    const again = resolveIdentity(repo, asCookieHeader(setCookies), opts);
    expect(again.identity.profile.id).toBe(identity.profile.id);
    expect(again.setCookies).toEqual([]);
  });

  it("rejects a profile from another device even with a valid signature, and falls back to its own", () => {
    const repo = setup();
    const me = resolveIdentity(repo, null, opts);
    const other = resolveIdentity(repo, null, opts);
    const myDevice = me.setCookies.find((c) => c.startsWith(DEVICE_COOKIE))!.split(";")[0];
    const theirProfile = other.setCookies.find((c) => c.startsWith(PROFILE_COOKIE))!.split(";")[0];
    const { identity, setCookies } = resolveIdentity(repo, `${myDevice}; ${theirProfile}`, opts);
    expect(identity.profile.id).toBe(me.identity.profile.id);
    expect(setCookies.some((c) => c.startsWith(PROFILE_COOKIE))).toBe(true);
  });

  it("treats a forged device cookie as a new visitor", () => {
    const repo = setup();
    const { identity } = resolveIdentity(repo, `${DEVICE_COOKIE}=someone-elses-id.fake-signature`, opts);
    expect(repo.listProfiles(identity.deviceId).filter((p) => !p.isDemo)).toHaveLength(1);
  });

  it("allows demo profiles from any device, but not other devices' profiles", () => {
    const repo = setup();
    const demo = repo.createProfile(null, "Demo", { isDemo: true });
    const me = resolveIdentity(repo, null, opts);
    const other = resolveIdentity(repo, null, opts);
    expect(switchProfile(repo, me.identity.deviceId, demo.id, opts)).toMatch(new RegExp(`^${PROFILE_COOKIE}=`));
    expect(switchProfile(repo, me.identity.deviceId, other.identity.profile.id, opts)).toBeUndefined();
  });

  it("recreates 'You' when a device has deleted all its own profiles", () => {
    const repo = setup();
    const first = resolveIdentity(repo, null, opts);
    repo.deleteProfile(first.identity.deviceId, first.identity.profile.id);
    const after = resolveIdentity(repo, asCookieHeader(first.setCookies), opts);
    expect(after.identity.deviceId).toBe(first.identity.deviceId);
    expect(after.identity.profile.id).not.toBe(first.identity.profile.id);
    expect(after.identity.profile.name).toBe("You");
  });
});
