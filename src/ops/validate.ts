/**
 * 操作入参校验。
 *
 * 这些字符串会被 `dsh plugin`（或宿主服务）当成参数使用。我们**不经过 shell**，
 * 所以不存在命令注入；但两类风险必须挡：
 *  1. **前导 `-`**：会被 pnpm / dsh 当成选项解析（例如 `--global`）；
 *  2. 空白与控制字符：会让参数被拆开或污染输出/日志。
 * 另外把长度收在 npm 的实际上限内（包名 214，spec 300）。
 */
export interface Validated {
  ok: true;
  value: string;
}
export interface Invalid {
  ok: false;
  reason: string;
}

const NAME = /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/;
// 首字符允许 `.`（相对路径 `../x`、`./x.tgz`）；`^` / `~` / `*` 开头另行拒绝。
/**
 * ⚠️ 允许 `\`：Windows 上绝对路径就是反斜杠（`file:D:\x\y`），而宿主自己的
 * `dependencySpec()` 也是用 `resolve()` 拼出来的同形地址。挡掉它会让「本地路径
 * 形态的更新」在 Windows 上永远装不了（本轮实测踩到）。我们不经 shell，反斜杠
 * 只是一条合法路径字符。
 */
const SPEC = /^[A-Za-z0-9@.][A-Za-z0-9@/._~:+#=^%\\-]*$/;
const CONTROL = /[\u0000-\u001f\u007f\s]/;

/** npm 包名（含 scope）校验。 */
export function validateName(input: unknown): Validated | Invalid {
  if (typeof input !== "string") return { ok: false, reason: "包名必须是字符串" };
  const name = input.trim();
  if (name === "") return { ok: false, reason: "包名不能为空" };
  if (name.length > 214) return { ok: false, reason: "包名过长（>214）" };
  if (CONTROL.test(name)) return { ok: false, reason: "包名含空白或控制字符" };
  if (name.startsWith("-") || !NAME.test(name))
    return { ok: false, reason: `包名不合法：${name}` };
  return { ok: true, value: name };
}

/**
 * 安装地址（spec）校验：包名、`@scope/name@1.2.3`、`github:o/r`、`git+https://…#ref`、
 * 绝对路径、`file:`、`.tgz` 直链都允许。
 */
export function validateSpec(input: unknown): Validated | Invalid {
  if (typeof input !== "string") return { ok: false, reason: "安装地址必须是字符串" };
  const spec = input.trim();
  if (spec === "") return { ok: false, reason: "安装地址不能为空" };
  if (spec.length > 300) return { ok: false, reason: "安装地址过长（>300）" };
  if (CONTROL.test(spec)) return { ok: false, reason: "安装地址含空白或控制字符" };
  if (spec.startsWith("-")) return { ok: false, reason: "安装地址不能以 `-` 开头" };
  /**
   * 以 `^` / `~` / `*` 开头说明这是一段**版本范围**而不是可安装目标
   * （`^1.9.28` 没有包名）。早点拒绝比交给 pnpm 报 404 更清楚。
   */
  if (/^[\^~*]/.test(spec))
    return { ok: false, reason: "安装地址缺少包名：不能以版本范围开头" };
  if (!SPEC.test(spec)) return { ok: false, reason: `安装地址含非法字符：${spec}` };
  return { ok: true, value: spec };
}

/** `confirm` 必须显式为 true：界面上的确认弹窗是这道校验的对应动作。 */
export function requireConfirm(input: unknown): Validated | Invalid {
  return input === true
    ? { ok: true, value: "confirmed" }
    : { ok: false, reason: "这个操作需要确认（界面会弹确认框）" };
}

/** 队列任务 id。 */
export function validateTaskId(input: unknown): Validated | Invalid {
  if (typeof input !== "string") return { ok: false, reason: "任务 id 必须是字符串" };
  const id = input.trim();
  if (id === "" || id.length > 120 || CONTROL.test(id))
    return { ok: false, reason: "任务 id 不合法" };
  return { ok: true, value: id };
}