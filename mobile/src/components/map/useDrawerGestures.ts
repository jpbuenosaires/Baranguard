import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { DEFAULT_PEEK_PX } from '../../utils/mapStatusLine';
import tacticalFeedback from '../../utils/tacticalFeedback';
import type { DrawerMode, SelectedItem } from '../../utils/mapFilters';

interface Args {
  drawerMode: DrawerMode;
  setDrawerMode: Dispatch<SetStateAction<DrawerMode>>;
  selectedItem: SelectedItem | null;
  setSelectedItem: Dispatch<SetStateAction<SelectedItem | null>>;
  /** Visible height of the collapsed drawer; fits its summary text. */
  peekPx?: number;
}

/** Real-time touch engine for the bottom sheet: direct 1:1 finger tracking, flick and snap thresholds. */
export function useDrawerGestures({ drawerMode, setDrawerMode, selectedItem, setSelectedItem, peekPx = DEFAULT_PEEK_PX }: Args) {
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartY = useRef(0);
  const touchStartTime = useRef(0);
  const currentDragY = useRef(0);
  const isInterceptionFromScroll = useRef(false);
  const scrollListRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: React.TouchEvent, fromScrollList = false) => {
    if (e.touches.length !== 1) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartTime.current = Date.now();
    currentDragY.current = 0;
    isInterceptionFromScroll.current = fromScrollList;
    setIsDragging(false);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const clientY = e.touches[0].clientY;
    const rawDelta = clientY - touchStartY.current;

    if (isInterceptionFromScroll.current) {
      const scrollEl = scrollListRef.current;
      // If user has scrolled down into the list, let native scroll work
      if (scrollEl && scrollEl.scrollTop > 0) {
        return;
      }
      // If at top of list and dragging downwards, intercept to collapse sheet
      if (rawDelta > 0) {
        currentDragY.current = rawDelta;
        setDragY(rawDelta);
        setIsDragging(true);
      }
      return;
    }

    // Dragging from handle bar, header, or preview card
    let effectiveDelta = rawDelta;
    if (drawerMode === 'peek' && rawDelta > 0) {
      effectiveDelta = Math.pow(rawDelta, 0.7);
    } else if (drawerMode === 'expanded' && rawDelta < 0) {
      effectiveDelta = -Math.pow(Math.abs(rawDelta), 0.7);
    }

    currentDragY.current = effectiveDelta;
    setDragY(effectiveDelta);
    setIsDragging(true);
  };

  const handleTouchEnd = () => {
    if (!isDragging && Math.abs(currentDragY.current) < 5) {
      setIsDragging(false);
      setDragY(0);
      return;
    }

    const elapsedMs = Math.max(1, Date.now() - touchStartTime.current);
    const velocity = currentDragY.current / elapsedMs;
    const delta = currentDragY.current;

    setIsDragging(false);
    setDragY(0);

    // Fast flick velocity detection
    if (velocity < -0.3) {
      tacticalFeedback.onTap();
      setDrawerMode('expanded');
      return;
    }

    if (velocity > 0.3) {
      tacticalFeedback.onTap();
      if (drawerMode === 'expanded') {
        if (selectedItem) {
          setDrawerMode('selected');
        } else {
          setDrawerMode('peek');
        }
      } else if (drawerMode === 'selected') {
        setSelectedItem(null);
        setDrawerMode('peek');
      }
      return;
    }

    // Distance-based snapping
    if (drawerMode === 'peek') {
      if (delta < -45) {
        tacticalFeedback.onTap();
        setDrawerMode('expanded');
      }
    } else if (drawerMode === 'expanded') {
      if (delta > 70) {
        tacticalFeedback.onTap();
        if (selectedItem) {
          setDrawerMode('selected');
        } else {
          setDrawerMode('peek');
        }
      }
    } else if (drawerMode === 'selected') {
      if (delta < -50) {
        tacticalFeedback.onTap();
        setDrawerMode('expanded');
      } else if (delta > 50) {
        tacticalFeedback.onTap();
        setSelectedItem(null);
        setDrawerMode('peek');
      }
    }
  };

  const fabYStyle = useMemo(() => {
    let base = `${DEFAULT_PEEK_PX - peekPx}px`;
    if (drawerMode === 'selected') base = '-139px';
    else if (drawerMode === 'expanded') base = 'calc(76px - 65dvh)';

    if (isDragging) {
      return `translateY(${base}) translateY(${dragY}px)`;
    }
    return `translateY(${base})`;
  }, [drawerMode, isDragging, dragY, peekPx]);

  const drawerYStyle = useMemo(() => {
    let base = `calc(100% - ${peekPx}px)`;
    if (drawerMode === 'selected') base = 'calc(100% - 215px)';
    else if (drawerMode === 'expanded') base = '0%';

    if (isDragging) {
      return `translateY(${base}) translateY(${dragY}px)`;
    }
    return `translateY(${base})`;
  }, [drawerMode, isDragging, dragY, peekPx]);

  return { isDragging, scrollListRef, handleTouchStart, handleTouchMove, handleTouchEnd, fabYStyle, drawerYStyle };
}
