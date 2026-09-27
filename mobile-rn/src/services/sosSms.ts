/**
 * sosSms.ts — the TypeScript edge of `modules/sos-sms` (Kotlin Expo
 * Module), port of ../mobile's sosSms.ts/SosSmsPlugin.java. See that
 * module's own header comment for the full reasoning (G1's third SOS
 * fallback tier, §2 Rule 27).
 */
import SosSms from '../../modules/sos-sms';

export async function sendSosSmsDirect(number: string, message: string): Promise<{ sent: boolean }> {
  return SosSms.sendDirect({ number, message });
}
