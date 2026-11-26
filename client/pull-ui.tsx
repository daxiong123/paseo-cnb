import { Text, TextInput, type TextInputProps } from "react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export type Theme = PluginSurfaceProps["theme"];

export function PullInput({ theme, style, ...props }: TextInputProps & { theme: Theme }) {
  return <TextInput
    {...props}
    placeholderTextColor={theme.colors.foregroundMuted}
    style={[{
      color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border,
      borderWidth: 1, borderRadius: 6, padding: 8, minHeight: props.multiline ? 72 : 40,
      textAlignVertical: "top",
    }, style]}
  />;
}

export function PullError({ theme, error, retry }: { theme: Theme; error?: string | null; retry?: () => void }) {
  if (!error) return null;
  return <>
    <Text accessibilityRole="alert" selectable style={{ color: theme.colors.foreground }}>{error}</Text>
    {retry && <SettingsAction label="CNB 请求失败" actionLabel="重试" onPress={retry} />}
  </>;
}
