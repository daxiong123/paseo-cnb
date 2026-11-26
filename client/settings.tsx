import { Fragment, type ReactNode } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import { connection } from "../shared/cnb";
import { checkConnection } from "./connection-cache";

function useConnection(hostId: string) {
  const request = useRpc(connection);
  const cache = useQueryClient();
  return useQuery({
    queryKey: ["cnb", hostId, "connection"],
    queryFn: () => checkConnection(cache, hostId, () => request({})),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

export function CnbAccount({ hostId, theme, children }: {
  hostId: string; theme: PluginSurfaceProps["theme"]; children: ReactNode;
}) {
  const status = useConnection(hostId);
  if (status.isError) return <SettingsAction label={status.error.message} actionLabel="重新检查 CNB 登录"
    disabled={status.isFetching} onPress={() => { void status.refetch(); }} />;
  if (!status.isSuccess || !status.isFetchedAfterMount) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>正在检查 CNB 登录</Text>;
  }
  return <Fragment key={status.data.username}>{children}</Fragment>;
}

export function ConnectionSettings({ theme, host }: PluginSurfaceProps) {
  const status = useConnection(host.id);
  const description = status.isFetching ? "正在检查 cnb-cli 和 CNB 登录"
    : status.error ? "连接检查失败"
    : status.data ? `${status.data.username} · cnb-cli ${status.data.cliVersion}` : "尚未检查";
  return (
    <SettingsSection title="CNB CLI 连接">
      <SettingsCard>
        <SettingsRow label="连接状态" error={status.error?.message}>
          <Text style={{ color: theme.colors.foreground }}>{description}</Text>
        </SettingsRow>
        <SettingsRow label="登录方式" hint="在 Paseo daemon 所在机器执行 cnb login --host cnb.cool" />
        <SettingsAction label="CLI 登录" actionLabel="检查连接" disabled={status.isFetching} onPress={() => { void status.refetch(); }} />
      </SettingsCard>
    </SettingsSection>
  );
}
