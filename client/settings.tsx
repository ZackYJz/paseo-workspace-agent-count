import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { counterRpc } from "../shared/counter";
import { displaySettings, settingsContracts } from "../shared/settings";
import { setTitleMode, type TitleModeRpc } from "./title-mode";

type Ready = Extract<SettingsState<typeof displaySettings.schema>, { status: "ready" }>;

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const readSettings = useRpc(settingsContracts.read);
  const writeSettings = useRpc(settingsContracts.write);
  const updateCounter = useRpc(counterRpc);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const calls: TitleModeRpc = useMemo(
    () => ({
      readSettings: () => readSettings({}),
      writeSettings: (input) => writeSettings(input),
      updateCounter: (input) => updateCounter(input),
    }),
    [readSettings, writeSettings, updateCounter],
  );

  const changeTitleCounts = useCallback(
    async (titleCounts: boolean) => {
      setBusy(true);
      setFailure(null);
      try {
        // One transition writes the preference and mirrors it onto the daemon
        // ledger, so the switch and the actual titles cannot disagree.
        await setTitleMode(calls, titleCounts);
        await settings.reload();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [calls, settings],
  );

  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme],
  );

  return (
    <SettingsSection title="会话数量">
      <SettingsCard>
        <SettingsSwitch
          label="在 workspace 标题前显示数量"
          hint="改写成 “(3) 原标题”。会写入持久化的 workspace 标题，关闭时自动恢复原标题。"
          value={settings.values.titleCounts}
          disabled={busy || settings.saving}
          onValueChange={(titleCounts) => void changeTitleCounts(titleCounts)}
        />
        <SettingsRow label="Agent 总览" hint="侧栏入口，实时列出每个 workspace 的会话数量，可点击跳转。始终开启，不改写任何数据。">
          <Text style={styles.muted}>只读</Text>
        </SettingsRow>
        <SettingsRow label="顶栏数量按钮" hint="每个 workspace 顶栏显示当前会话数，点开展示是哪几个会话。始终开启。">
          <Text style={styles.muted}>只读</Text>
        </SettingsRow>
      </SettingsCard>
      {failure || settings.saveError ? (
        <Text accessibilityRole="alert" style={styles.danger}>
          {failure ?? settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

export function TitleModeSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme],
  );

  if (settings.status === "loading") return <Text style={styles.text}>正在读取设置…</Text>;

  if (settings.status !== "ready")
    return (
      <SettingsSection title="会话数量">
        <Text style={styles.danger}>{settings.error}</Text>
        <SettingsAction
          label="重新读取"
          actionLabel="重试"
          onPress={() => void settings.reload()}
        />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="恢复默认设置"
            actionLabel="重置"
            onPress={() => void settings.reset()}
          />
        ) : null}
      </SettingsSection>
    );

  return <Controls settings={settings} theme={theme} />;
}
