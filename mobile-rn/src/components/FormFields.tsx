/**
 * Port of ../mobile's FormFields.tsx. The original existed entirely to
 * work around @ionic/react 9's `onIonInput` prop silently not firing on
 * React 19 — RN's `TextInput.onChangeText` has no such bridge, so this is
 * a plain controlled-input wrapper, not a workaround.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secureTextEntry?: boolean;
  disabled?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'phone-pad';
  placeholder?: string;
}

export function TextField({
  label,
  value,
  onChange,
  secureTextEntry,
  disabled,
  autoCapitalize = 'sentences',
  keyboardType = 'default',
  placeholder,
}: TextFieldProps) {
  const { colors, tokens } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={secureTextEntry}
        editable={!disabled}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.textDisabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            color: colors.textPrimary,
            borderColor: focused ? colors.primary : colors.border,
            backgroundColor: colors.surface,
            borderRadius: tokens.radius.sm,
            opacity: disabled ? 0.6 : 1,
          },
        ]}
      />
    </View>
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
  placeholder?: string;
}

export function TextAreaField({ label, value, onChange, rows = 6, disabled, placeholder }: TextAreaFieldProps) {
  const { colors, tokens } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        multiline
        numberOfLines={rows}
        placeholder={placeholder}
        placeholderTextColor={colors.textDisabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          styles.textArea,
          {
            color: colors.textPrimary,
            borderColor: focused ? colors.primary : colors.border,
            backgroundColor: colors.surface,
            borderRadius: tokens.radius.sm,
            opacity: disabled ? 0.6 : 1,
            minHeight: rows * 22,
          },
        ]}
      />
    </View>
  );
}

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  disabled?: boolean;
}

/** A row of choice chips — no native picker modal needed for the short option lists this app uses (incident type, priority). */
export function SelectField<T extends string>({ label, value, onChange, options, disabled }: SelectFieldProps<T>) {
  const { colors, tokens } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={[
                styles.chip,
                {
                  borderRadius: tokens.radius.lg,
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.tintInfoBg : colors.surface,
                  opacity: disabled ? 0.6 : 1,
                },
              ]}
            >
              <Text style={{ color: selected ? colors.pillInfoText : colors.textSecondary, fontWeight: selected ? '600' : '400' }}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  textArea: { textAlignVertical: 'top', paddingTop: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
});
