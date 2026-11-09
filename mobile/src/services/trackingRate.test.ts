import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAST_BROADCAST_INTERVAL_MS,
  NORMAL_BROADCAST_INTERVAL_MS,
  SOS_ACTIVE_WINDOW_MS,
  broadcastIntervalMs,
  isFastRate,
  isFastTracking,
  noteSosRaised,
  reapplyTrackingRate,
  resetTrackingRate,
  setFastModeSink,
  setTrackingDispatches,
  setTrackingDuty,
} from './trackingRate';

const base = { dutyStatus: 'on_duty', dispatchStatuses: [] as string[], sosRaisedAt: null as number | null, now: 1_000_000 };

describe('isFastRate', () => {
  it('is NORMAL off duty or with unknown duty, whatever else is active', () => {
    for (const dutyStatus of ['off_duty', null]) {
      expect(isFastRate({ ...base, dutyStatus, dispatchStatuses: ['arrived'], sosRaisedAt: base.now })).toBe(false);
    }
  });

  it('is NORMAL on duty and idle', () => {
    expect(isFastRate(base)).toBe(false);
  });

  it.each(['assigned', 'en_route', 'arrived'])('is FAST on duty with a %s dispatch', (status) => {
    expect(isFastRate({ ...base, dispatchStatuses: [status] })).toBe(true);
    expect(isFastRate({ ...base, dutyStatus: 'responding', dispatchStatuses: [status] })).toBe(true);
  });

  it.each(['completed', 'cancelled'])('ignores a %s dispatch', (status) => {
    expect(isFastRate({ ...base, dispatchStatuses: [status] })).toBe(false);
  });

  it('is FAST for any active dispatch among finished ones', () => {
    expect(isFastRate({ ...base, dispatchStatuses: ['completed', 'en_route', 'cancelled'] })).toBe(true);
  });

  it('is FAST for an active SOS and NORMAL once the SOS window has passed', () => {
    expect(isFastRate({ ...base, sosRaisedAt: base.now - 1000 })).toBe(true);
    expect(isFastRate({ ...base, sosRaisedAt: base.now - SOS_ACTIVE_WINDOW_MS })).toBe(false);
  });
});

describe('tracking rate state', () => {
  const sink = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    sink.mockReset();
    resetTrackingRate();
    setTrackingDispatches([]);
    reapplyTrackingRate();
    setFastModeSink(sink);
    sink.mockReset();
  });

  afterEach(() => {
    resetTrackingRate();
    setFastModeSink(null);
    vi.useRealTimers();
  });

  it('calls the sink only when the derived rate changes', () => {
    setTrackingDuty('on_duty');
    expect(sink).not.toHaveBeenCalled();
    setTrackingDispatches(['assigned']);
    setTrackingDispatches(['en_route']);
    expect(sink.mock.calls).toEqual([[true]]);
    setTrackingDispatches(['completed']);
    expect(sink.mock.calls).toEqual([[true], [false]]);
  });

  it('follows the dispatch: FAST until it completes, with the broadcast interval to match', () => {
    setTrackingDuty('on_duty');
    expect(broadcastIntervalMs()).toBe(NORMAL_BROADCAST_INTERVAL_MS);
    setTrackingDispatches(['arrived']);
    expect(isFastTracking()).toBe(true);
    expect(broadcastIntervalMs()).toBe(FAST_BROADCAST_INTERVAL_MS);
    setTrackingDispatches(['cancelled']);
    expect(isFastTracking()).toBe(false);
  });

  it('stays NORMAL for a dispatch while off duty and turns FAST when duty starts', () => {
    setTrackingDispatches(['assigned']);
    expect(sink).not.toHaveBeenCalled();
    setTrackingDuty('on_duty');
    expect(sink.mock.calls).toEqual([[true]]);
  });

  it('SOS is FAST, then drops back by itself when the window ends', () => {
    setTrackingDuty('on_duty');
    noteSosRaised();
    expect(sink.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(SOS_ACTIVE_WINDOW_MS + 100);
    expect(sink.mock.calls).toEqual([[true], [false]]);
    expect(isFastTracking()).toBe(false);
  });

  it('duty end clears FAST and a forgotten SOS, even with a dispatch row left', () => {
    setTrackingDuty('on_duty');
    setTrackingDispatches(['en_route']);
    noteSosRaised();
    setTrackingDuty('off_duty');
    expect(sink.mock.calls).toEqual([[true], [false]]);
    setTrackingDuty('on_duty'); // dispatch still active -> FAST again, but no SOS left
    setTrackingDispatches(['completed']);
    expect(isFastTracking()).toBe(false);
  });

  it('reset (patrol stop / sign-out) drops FAST and the SOS', () => {
    setTrackingDuty('on_duty');
    noteSosRaised();
    resetTrackingRate();
    expect(sink.mock.calls).toEqual([[true], [false]]);
    setTrackingDuty('on_duty');
    expect(isFastTracking()).toBe(false);
  });

  it('reapply re-sends the current mode after the native service restarts', () => {
    setTrackingDuty('on_duty');
    setTrackingDispatches(['assigned']);
    sink.mockClear();
    reapplyTrackingRate();
    expect(sink.mock.calls).toEqual([[true]]);
  });
});
