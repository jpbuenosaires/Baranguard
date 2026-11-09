/** Dispatch status wording and stage order shared by the assignment detail view components. */
import type { nextStatusFor } from '../services/db/dispatchRepository';

export const STATUS_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  en_route: 'En Route',
  arrived: 'Arrived at Scene',
  completed: 'Completed',
};

export const STAGE_ORDER: Record<string, number> = {
  assigned: 1,
  en_route: 2,
  arrived: 3,
  completed: 4,
};

export const STAGES = ['assigned', 'en_route', 'arrived', 'completed'] as const;

/** Short names printed under the stage bar's segments. */
export const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  assigned: 'Assigned',
  en_route: 'En route',
  arrived: 'On scene',
  completed: 'Done',
};

/** Shown when the desk sent no summary; the list card hides it because it repeats on every call. */
export const DEFAULT_DISPATCH_SUMMARY = 'Patrol dispatched to check the area and assist with the incident.';

/** 'info' auto-clears; 'queued' and 'error' stay until the Tanod dismisses them. */
export type NoteKind = 'info' | 'queued' | 'error';

export type NextDispatchStatus = ReturnType<typeof nextStatusFor>;
