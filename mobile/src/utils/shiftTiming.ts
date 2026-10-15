/** Shift date/time labels for the Tanod roster screens (moved out of my-shifts.tsx, Phase 6). */

export interface FormattedShiftTime {
  dateLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  timeRange: string;
  durationLabel: string;
}

export function parseShiftTiming(startAt: string, endAt: string): FormattedShiftTime {
  const start = new Date(startAt);
  const end = new Date(endAt);

  const now = new Date();
  const todayStr = now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toDateString();

  const isToday = start.toDateString() === todayStr;
  const isTomorrow = start.toDateString() === tomorrowStr;

  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  };
  const baseDate = start.toLocaleDateString(undefined, dateOptions);
  const dateLabel = isToday ? `Today · ${baseDate}` : isTomorrow ? `Tomorrow · ${baseDate}` : baseDate;

  const startTimeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTimeStr = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffHours = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60));
  const durationLabel = diffHours > 0 ? `${diffHours}h` : '';

  return {
    dateLabel,
    isToday,
    isTomorrow,
    timeRange: `${startTimeStr} – ${endTimeStr}`,
    durationLabel,
  };
}
