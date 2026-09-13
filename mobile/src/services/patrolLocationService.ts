/**
 * patrolLocationService.ts — the TypeScript edge of
 * `PatrolLocationService.java`/`PatrolLocationPlugin.java` (Android), a
 * LOCAL custom Capacitor plugin (not an npm dependency) for the
 * background patrol GPS foreground service (Mobile Improvement Plan
 * Phase 4.1).
 *
 * `home.tsx` calls `startPatrolTracking()` when duty status becomes
 * `on_duty` (including on load, if already on duty from a previous
 * session) and `stopPatrolTracking()` on going off duty or signing out.
 * Both are best-effort: a rejected `start()` (e.g. permission genuinely
 * missing) is caught and swallowed by the caller, same non-fatal
 * treatment every other native-plugin edge in this app already gets —
 * duty status itself must never be blocked by a tracking side-channel.
 *
 * NOT DEVICE-VERIFIED for a completed multi-hour background run (same
 * disclosure this codebase gives every native-plugin edge): the plugin
 * registers and the app doesn't crash on a running device, but a real
 * shift-length backgrounded run, screen-off battery/Doze behavior, and
 * the OS actually restarting a killed service were not exercised this
 * session.
 */

import { registerPlugin } from '@capacitor/core';

export interface PatrolLocationPlugin {
  start(): Promise<{ started: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
}

const PatrolLocation = registerPlugin<PatrolLocationPlugin>('PatrolLocation');

/** Starts the foreground GPS service. Never throws — a failure (e.g. permission missing) is logged nowhere and simply doesn't start tracking; duty status itself is never blocked by this. */
export async function startPatrolTracking(): Promise<void> {
  try {
    await PatrolLocation.start();
  } catch {
    // Best-effort — see this file's header comment.
  }
}

export async function stopPatrolTracking(): Promise<void> {
  try {
    await PatrolLocation.stop();
  } catch {
    // Best-effort — stopping a service that isn't running is a no-op we don't need to distinguish from a real error here.
  }
}
