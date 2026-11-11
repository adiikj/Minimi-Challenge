import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEVICE_COOKIE = "minimi_device";
export const PROFILE_COOKIE = "minimi_profile";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

const mac = (secret: string, name: string, value: string) =>
  createHmac("sha256", secret).update(`${name}:${value}`).digest("base64url");

export function sign(secret: string, name: string, value: string): string {
  return `${value}.${mac(secret, name, value)}`;
}

export function verify(secret: string, name: string, signed: string | undefined): string | undefined {
  if (!signed) return undefined;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const value = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(secret, name, value));
  return given.length === expected.length && timingSafeEqual(given, expected) ? value : undefined;
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_S}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

export function loadOrCreateSecret(envSecret: string | undefined, file: string): string {
  if (envSecret && envSecret.length >= 16) return envSecret;
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
