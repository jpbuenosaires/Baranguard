/**
 * A small pill for the header's status row (duty / connection / GPS on
 * Home). Not HeroUI's `Chip` — these are read-only glanceable indicators,
 * not pressable filters/tags, and always sit on the navy header, never on
 * a themed surface, so they carry their own fixed-on-navy colors rather
 * than the light/dark `Chip` variants.
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

interface StatusChipProps {
  icon?: ReactNode;
  dotColor?: string;
  label: string;
}

export default function StatusChip({ icon, dotColor, label }: StatusChipProps) {
  return (
    <View className="flex-row items-center gap-1.5 h-8 px-3 rounded-full bg-white/10">
      {dotColor ? <View className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} /> : icon}
      <Text className="text-[13px] font-semibold text-white">{label}</Text>
    </View>
  );
}
