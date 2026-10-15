/**
 * A 401 on an authenticated call normally means the session died (expired, revoked, password changed).
 * A failed DEVICE SIGNATURE is different: the session is fine, the write was refused (for example the phone
 * and workstation clocks disagree by more than the allowed skew). It must not sign the Tanod out.
 */
export function isSessionEndingUnauthorized(status: number, message: string | undefined): boolean {
  if (status !== 401) return false;
  return !/device signature/i.test(message ?? '');
}
