/**
 * A circular progress ring drawn with react-native-svg. Presentational only
 * — the caller owns the timer/state driving `progress` (see HomeScreen's
 * SOS hold-to-confirm, the one thing that currently needs it). Kept in
 * `src/ui/` rather than inline because a hold-to-confirm ring is exactly
 * the kind of thing another screen (e.g. a future "hold to cancel dispatch"
 * control) is likely to want without redrawing the SVG math.
 */
import { View, type ViewStyle } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface RingProgressProps {
  size: number;
  strokeWidth: number;
  /** 0–1. Values outside that range are clamped. */
  progress: number;
  trackColor: string;
  fillColor: string;
  children?: React.ReactNode;
  style?: ViewStyle;
}

export default function RingProgress({ size, strokeWidth, progress, trackColor, fillColor, children, style }: RingProgressProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = circumference * (1 - clamped);
  const center = size / 2;

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }}>
        <Circle cx={center} cy={center} r={radius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        {clamped > 0 ? (
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={fillColor}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="round"
            rotation={-90}
            origin={`${center}, ${center}`}
          />
        ) : null}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
    </View>
  );
}
