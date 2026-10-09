/**
 * Audible cue for a NEW sos/priority_alert notification landing on the
 * web dashboard, so a dispatcher with the tab backgrounded or the sound
 * off their attention doesn't rely on the topbar bell's badge dot alone
 * (an 2026-09-24 audit finding: the bell had no sound at all). Synthesized
 * via Web Audio, same technique as mobile/src/utils/tacticalFeedback.ts's
 * `playTone` — kept as an independent copy since the two apps share no JS
 * runtime.
 *
 * Browsers block audio until the page has had a user gesture (a click,
 * keypress) at least once — a real platform limitation, not a bug here.
 * `isAlertSoundUnlocked()` / `onAlertSoundUnlocked()` let a caller show a
 * "Click anywhere to enable alert sound" hint while that is the case
 * (audit 2026-10-09 A-08).
 *
 * De-duplication (audit 2026-10-09 A-08/X-01): the site-wide SOS bar in
 * AppShell and the Dispatch Center's own banner both repeat the tone every
 * 10 s while an SOS is unacknowledged. Two independent 10 s loops would
 * play two overlapping chimes per period, so `playCriticalAlertTone()` is
 * throttled here, in the one module both call: a call within
 * MIN_TONE_GAP_MS of the previous tone is skipped. One loop or two, the
 * operator hears one chime per ~10 s.
 */
let sharedContext = null;

/** Two loops on a 10 s period drift by at most a few hundred ms; 9 s keeps exactly one tone per period. */
export const MIN_TONE_GAP_MS = 9000;
let lastToneAt = -Infinity;

// --- Autoplay unlock tracking ------------------------------------------------
let unlocked = Boolean(typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive);
const unlockListeners = new Set();
function markUnlocked() {
  if (unlocked) return;
  unlocked = true;
  if (sharedContext && sharedContext.state === 'suspended') {
    try { void sharedContext.resume(); } catch { /* non-fatal */ }
  }
  for (const fn of [...unlockListeners]) {
    try { fn(); } catch { /* a listener's failure must not stop the others */ }
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', markUnlocked, { capture: true });
  document.addEventListener('keydown', markUnlocked, { capture: true });
}

/** True once the page has had a user gesture, so audio can actually play. */
export function isAlertSoundUnlocked() {
  return unlocked;
}

/** Calls `fn` once audio becomes playable. Returns an unsubscribe function. */
export function onAlertSoundUnlocked(fn) {
  unlockListeners.add(fn);
  return () => unlockListeners.delete(fn);
}

function getContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedContext) sharedContext = new AudioCtx();
  if (sharedContext.state === 'suspended') void sharedContext.resume();
  return sharedContext;
}

function tone(context, frequency, startOffsetSec, durationMs, gainVal) {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'square';
  const start = context.currentTime + startOffsetSec;
  const durSec = durationMs / 1000;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(gainVal, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, start + durSec);
  osc.connect(gain);
  gain.connect(context.destination);
  osc.start(start);
  osc.stop(start + durSec);
}

/**
 * Three-tone alert pattern — loud enough to notice over ambient office
 * noise, short enough not to grate if several land close together.
 * Returns true when a tone was started, false when it was skipped (another
 * caller played one less than MIN_TONE_GAP_MS ago, or audio is unavailable).
 */
export function playCriticalAlertTone({ now = Date.now() } = {}) {
  if (now - lastToneAt < MIN_TONE_GAP_MS) return false;
  lastToneAt = now;
  try {
    const context = getContext();
    if (!context) return false;
    tone(context, 880, 0, 180, 0.2);
    tone(context, 660, 0.22, 180, 0.2);
    tone(context, 880, 0.44, 220, 0.2);
    return true;
  } catch {
    // Autoplay policy or no AudioContext support — non-fatal, the visual badge still updates.
    return false;
  }
}

/** Test-only: reset the throttle and unlock state between tests. */
export function __resetAlertSoundForTests({ unlocked: next = false } = {}) {
  lastToneAt = -Infinity;
  unlocked = next;
  unlockListeners.clear();
}
