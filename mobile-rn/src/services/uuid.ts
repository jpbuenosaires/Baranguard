import { randomUUID } from 'expo-crypto';

/** RFC 4122 v4 UUID from the platform CSPRNG (no Math.random fallback). */
export function uuid(): string {
  return randomUUID();
}
