import { manilaToday } from './manilaTime';

/** Accomplishment entry form state and duration helpers (moved out of accomplishments.tsx, Phase 6). */
export interface FormState {
  workDate: string;
  text: string;
  startTime: string;
  endTime: string;
  hours: string;
  minutes: string;
}

export const emptyForm = (): FormState => ({ workDate: manilaToday(), text: '', startTime: '', endTime: '', hours: '', minutes: '' });

export function splitMinutes(total: number): { hours: string; minutes: string } {
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

export function formMinutes(form: FormState): number {
  return (Number(form.hours) || 0) * 60 + (Number(form.minutes) || 0);
}
