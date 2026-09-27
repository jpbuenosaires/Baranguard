/**
 * The navy field-console header used at the top of every tab screen —
 * approved in the Home mockup (2026-09-27 UI redesign). `eyebrow`/`title`
 * are the officer/barangay identity line; `right` is a single icon button
 * (the notification bell on Home); `children`, when given, is a row of
 * `StatusChip`s directly under the title (duty/online/GPS on Home — other
 * screens can omit it).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface AppHeaderProps {
  eyebrow?: string;
  title: string;
  onRightPress?: () => void;
  rightIcon?: ReactNode;
  rightLabel?: string;
  children?: ReactNode;
}

export default function AppHeader({ eyebrow, title, onRightPress, rightIcon, rightLabel, children }: AppHeaderProps) {
  return (
    <SafeAreaView edges={['top']} className="bg-[#1e3a6e] dark:bg-[#0f1b36]">
      <View className="px-5 pt-3 pb-4 gap-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="shrink">
            {eyebrow ? <Text className="text-[13px] font-medium text-[#bfdbfe] dark:text-[#93c5fd]">{eyebrow}</Text> : null}
            <Text className="text-[22px] font-bold text-white" numberOfLines={1}>
              {title}
            </Text>
          </View>
          {onRightPress ? (
            <Pressable
              onPress={onRightPress}
              accessibilityRole="button"
              accessibilityLabel={rightLabel}
              className="w-12 h-12 rounded-2xl bg-white/10 items-center justify-center active:bg-white/20"
            >
              {rightIcon}
            </Pressable>
          ) : null}
        </View>
        {children ? <View className="flex-row gap-2 flex-wrap">{children}</View> : null}
      </View>
    </SafeAreaView>
  );
}
