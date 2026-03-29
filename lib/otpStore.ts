import { randomInt } from "crypto";

type OtpEntry = {
  otp: string;
  expiresAt: number;
};

const otpCache = new Map<string, OtpEntry>();

export function createOtp(email: string, ttlMs = 10 * 60 * 1000) {
  const otp = randomInt(100000, 1000000).toString();
  otpCache.set(email.toLowerCase(), { otp, expiresAt: Date.now() + ttlMs });
  return otp;
}

export function verifyOtp(email: string, otp: string) {
  const key = email.toLowerCase();
  const entry = otpCache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    otpCache.delete(key);
    return false;
  }
  const ok = entry.otp === otp;
  if (ok) otpCache.delete(key);
  return ok;
}

export function clearOtp(email: string) {
  otpCache.delete(email.toLowerCase());
}
