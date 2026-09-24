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
 * A dashboard that's sat untouched since load may play its first alert
 * silently; nothing recoverable from JS, so this is disclosed rather than
 * worked around.
 */
let sharedContext = null;

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

/** Three-tone alert pattern — loud enough to notice over ambient office noise, short enough not to grate if several land close together. */
export function playCriticalAlertTone() {
  try {
    const context = getContext();
    if (!context) return;
    tone(context, 880, 0, 180, 0.2);
    tone(context, 660, 0.22, 180, 0.2);
    tone(context, 880, 0.44, 220, 0.2);
  } catch {
    // Autoplay policy or no AudioContext support — non-fatal, the visual badge still updates.
  }
}
