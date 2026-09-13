/**
 * tacticalFeedback.ts — Device-agnostic audio tone synthesis and haptic vibrations.
 *
 * Uses the Web Audio API (AudioContext) and Navigator.vibrate to provide
 * tactile confirmation for field responders without requiring external MP3/WAV assets.
 */

class TacticalFeedback {
  private ctx: AudioContext | null = null;

  private getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  /** Plays a pure synthesized tone with smooth attack and release. */
  playTone(frequency: number, durationMs: number, type: OscillatorType = 'sine', gainVal = 0.15): void {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(frequency, ctx.currentTime);

      const now = ctx.currentTime;
      const durSec = durationMs / 1000;

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(gainVal, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durSec);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + durSec);
    } catch {
      // Audio autoplay policy may suppress; non-fatal
    }
  }

  /** Vibrate helper with fallback guard. */
  vibrate(pattern: number | number[]): void {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(pattern);
      }
    } catch {
      // Haptics unavailable
    }
  }

  /** Tactile response when officer toggles duty status. */
  onDutyToggle(isOnDuty: boolean): void {
    this.vibrate([40, 50, 40]);
    if (isOnDuty) {
      this.playTone(523.25, 120, 'sine', 0.12); // C5
      setTimeout(() => this.playTone(659.25, 180, 'sine', 0.14), 100); // E5
    } else {
      this.playTone(659.25, 120, 'sine', 0.12); // E5
      setTimeout(() => this.playTone(523.25, 180, 'sine', 0.1), 100); // C5
    }
  }

  /** Subtle tick sound & pulse during SOS 2-second hold. */
  onSosHoldTick(progressPercent: number): void {
    this.vibrate(25);
    const baseFreq = 700 + (progressPercent / 100) * 400; // Rising pitch 700Hz -> 1100Hz
    this.playTone(baseFreq, 40, 'sine', 0.1);
  }

  /** Emergency siren chime & intense vibration when SOS is fired. */
  onSosFired(): void {
    this.vibrate([150, 80, 150, 80, 300]);
    this.playTone(880, 200, 'sawtooth', 0.25);
    setTimeout(() => this.playTone(440, 250, 'sawtooth', 0.25), 200);
    setTimeout(() => this.playTone(880, 300, 'sawtooth', 0.25), 450);
  }

  /** Success chime for completed sync or saved report. */
  onSuccess(): void {
    this.vibrate([30, 40, 30]);
    this.playTone(523.25, 80, 'triangle', 0.1);
    setTimeout(() => this.playTone(659.25, 80, 'triangle', 0.12), 70);
    setTimeout(() => this.playTone(783.99, 140, 'triangle', 0.15), 140);
  }
}

export const tacticalFeedback = new TacticalFeedback();
export default tacticalFeedback;
