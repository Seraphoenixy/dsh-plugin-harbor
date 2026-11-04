/** 已在 DSH 内置 bundle 声明中核实的精确 id/module 对；不按包名前缀猜归属。 */
export const BUILTIN_PATCH_ROWS: Readonly<Record<string, string>> = {
  "ui-settings-general": "@deepseek-ai/dsh-client-ui-settings-general",
  "agent-default-model": "@deepseek-ai/dsh-agent-default-model",
  permission: "@deepseek-ai/dsh-permission-presets",
  "ui-theme": "@deepseek-ai/dsh-client-ui-theme",
  "ui-chat": "@deepseek-ai/dsh-client-ui-chat",
  "ui-settings": "@deepseek-ai/dsh-client-ui-settings",
  "ui-settings-account": "@deepseek-ai/dsh-client-ui-settings-account",
  "llm-deepseek": "@deepseek-ai/dsh-llm-deepseek-api-key",
  "llm-pi-ai": "@deepseek-ai/dsh-llm-pi-ai",
  "session-log-deepseek": "@deepseek-ai/dsh-session-log-deepseek",
  "agent-preset-registry": "@deepseek-ai/dsh-agent-preset-registry",
};
export interface PatchIdentity {
  id?: string;
  name?: string;
}
export function isBuiltinPatch(row: PatchIdentity): boolean {
  return (
    !!row.id &&
    !!row.name &&
    Object.hasOwn(BUILTIN_PATCH_ROWS, row.id) &&
    BUILTIN_PATCH_ROWS[row.id] === row.name
  );
}
export function unresolvedPatchReason(row: PatchIdentity): string {
  return row.name
    ? "模块未匹配导出范围内已装插件的声明；是否仍有效未确认，不自动应用或删除"
    : "缺少模块名，条目 ID 未唯一匹配当前已装插件声明；可能为动态条目或历史配置，不能确认无用";
}
