/**
 * 已装事实 → pnpm 能吃的安装地址。
 *
 * ⚠️ 为什么必须有这一层：profile 的 `package.json` / `pnpm-lock.yaml` 里记的是
 * **依赖的取值**，不是安装地址。registry 形态记的是版本范围（`^1.9.28`），而
 * `pnpm add ^1.9.28` 会把这段范围当成**包名**去解析，直接报
 * `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`（本轮实测：更新 dsh-cost-meter
 * 时先卸载成功、后安装失败，profile 里就少了这个依赖）。
 *
 * 拼法与宿主内的 `dependencySpec()` 同一口径，避免两边对同一个依赖得出不同的地址：
 *  - registry 范围 / tag / 别名 → `<包名>@<取值>`；
 *  - `file:` / `link:` 本地路径 → 相对 profile 解析成绝对路径（`~` 展开成 home）；
 *  - 其它协议（git / github / https / scp 形态）→ 原样，**不拼 `@latest`**；
 *  - 记录值挂在别的包名下时（依赖键 ≠ 包自己声明的名字）→ 前置 `<包名>@`。
 *
 * ⚠️ 不知道 profile 目录时**不改写**本地相对路径（透传原值），而不是拿进程 cwd 去猜
 * —— 猜错会把包从毫无关系的位置装进来。
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** 依赖取值的形态（`InstalledPlugin` 的那几个字段）。 */
export interface SpecSource {
  /** profile `dependencies` 里的键。 */
  name: string;
  /** 记录的取值（可能是范围、也可能是地址）。 */
  spec: string;
  kind: "registry" | "git" | "path" | "tarball" | "unknown";
  /** 已装包自己声明的名字（读得到才有）。 */
  packageName?: string;
}

const LOCAL_PROTOCOL = /^(file|link):(.*)$/s;
/**
 * registry 之外的协议：git/github/https/ssh… 以及 scp 形态的 `git@host:path`。
 * `npm:`（别名）与 `jsr:` / `workspace:` / `catalog:` 仍按 registry 口径拼。
 */
const NON_REGISTRY_VALUE = /^(?!(?:npm|jsr|workspace|catalog):)[a-z][a-z0-9+.-]*:|^[^@/:\s]+@[^:/\s]+:/i;
/** http(s) 地址里的用户信息（可能带密码或令牌）。 */
const HTTP_USER_INFO = /^((?:git\+)?https?:\/\/)[^/]*@/i;

/** 抹掉地址里的凭据：操作页会把地址显示出来，也会落进操作历史。 */
export function redactSpec(value: string): string {
  return value.replace(HTTP_USER_INFO, "$1");
}

/**
 * 组装安装地址。
 *
 * @param source 已装事实（依赖键、取值、形态）。
 * @param profileDir profile 目录；缺省时本地相对路径原样透传。
 * @param targetVersion registry 形态要装到哪个版本（核实过的那个）；缺省用记录的范围。
 */
export function installSpecFor(
  source: SpecSource,
  profileDir?: string,
  targetVersion?: string,
): string {
  const name = source.name;
  const recorded = (source.spec ?? "").trim();
  const local = LOCAL_PROTOCOL.exec(recorded);
  if (local) return withName(name, `${local[1]}:${absoluteLocal(local[2]!, profileDir)}`, source.packageName);
  if (recorded !== "" && NON_REGISTRY_VALUE.test(recorded))
    return withName(name, redactSpec(recorded), source.packageName);
  if (source.kind === "path" || source.kind === "tarball") {
    if (profileDir === undefined) return withName(name, recorded, source.packageName);
    const bare = recorded.replace(/^(file|link):/, "");
    return withName(name, `file:${absoluteLocal(bare, profileDir)}`, source.packageName);
  }
  const range = targetVersion !== undefined && targetVersion !== "" ? targetVersion : recorded;
  return `${name}@${range === "" ? "latest" : range}`;
}

/**
 * 子进程兜底时用的地址（没有服务端预先算好的 `installSpec` 时才走这里）。
 *
 * ⚠️ 不能对 git / 路径 / 压缩包 spec 无脑拼 `@latest`：`github:o/r@latest` 是无效
 * 地址（实测语义错误），git 直接原样重装即可解析到分支头。只有 registry 形态
 * 才用 `<name>@latest`。
 */
export function latestSpec(
  kind: string | undefined,
  spec: string,
  name: string,
  profileDir?: string,
): string {
  const text = spec.trim();
  if (kind === "registry") return `${name}@latest`;
  // 形态未知时按 spec 长相反推：`^1.9.28` / `~1.2` / `1.2.3` / `*` / `latest` 都是
  // registry 口径；`github:o/r`、`file:…`、`.tgz` 都不该拼 `@latest`。
  const looksRegistry =
    kind === undefined && (/^(\^|~)?\d|^\*$|^latest$/i.test(text) || text === "");
  if (looksRegistry) return `${name}@latest`;
  if (kind === undefined && text === "") return `${name}@latest`;
  return installSpecFor(
    { name, spec: text, kind: kind === "git" || kind === "path" || kind === "tarball" ? kind : "unknown" },
    profileDir,
  );
}

/** 本地路径转绝对路径：`~` 展开成 home；不知道 profile 目录时不动相对路径。 */
function absoluteLocal(path: string, profileDir?: string): string {
  const expanded = path.replace(/^~(?=$|[\\/])/, () => homedir());
  if (isAbsolute(expanded)) return expanded;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) return expanded;
  return profileDir === undefined ? expanded : resolve(profileDir, expanded);
}

/** 依赖键与包名不同时，pnpm 需要 `<依赖键>@<地址>` 才能装到该键下。 */
function withName(name: string, spec: string, packageName?: string): string {
  const own = packageName ?? name;
  return own === name ? spec : `${name}@${spec}`;
}