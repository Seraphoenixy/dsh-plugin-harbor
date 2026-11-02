/**
 * React Flight（RSC）载荷读取。
 *
 * 站点是 Next.js 应用，`/zh/plugins` 与插件详情页的数据都嵌在 HTML 的
 * `self.__next_f.push([1,"…"])` 片段里（实测索引页 6 段 / 106,535 字符，
 * 详情页 54,122 字符）。目录清单与单插件事实**只在这里**，没有 JSON 接口
 * （`/directory/zh/manifest.json` 等 5 个候选路径实测全 404）。
 *
 * ⚠️ 两层解析都必须容错：站点改版时「读不到」要能分辨成「结构变了」并走兜底，
 * 而不是静默变成空清单（AGENTS.md 的数据来源纪律）。
 */

/** 从 HTML 里取出并反转义全部 RSC 片段，按出现顺序拼接。 */
export function extractFlightPayload(html: string): string {
  const marker = "self.__next_f.push(";
  let cursor = 0;
  let out = "";
  for (;;) {
    const at = html.indexOf(marker, cursor);
    if (at === -1) break;
    cursor = at + marker.length;
    const literal = readStringLiteral(html, cursor);
    if (literal !== null) out += literal;
  }
  return out;
}

/**
 * 读一个 JS 字符串字面量。
 *
 * ⚠️ 不能用 `/\[1,"([\s\S]*?)"\]\)/` 这类非贪婪正则：载荷内部含 `\"` 转义，
 * 一旦出现形如 `")` 的内容就会提前截断。这里按转义规则逐字符扫描到真正的
 * 结束引号，因此对载荷内容免疫。
 *
 * ⚠️ 转义跳步必须算准（本轮实测踩到）：`\uXXXX` 之后应跳过**5**个字符
 * （`u` + 4 位十六进制），`\xNN` 之后跳过 3 个（`x` + 2 位），否则十六进制的
 * 尾字符会被当成普通字符吐进结果。
 */
function readStringLiteral(source: string, from: number): string | null {
  let i = from;
  // 形如 `[1,"…"]`：跳过数组起始、索引与逗号，定位到字符串起始引号。
  while (i < source.length && source[i] !== '"') {
    const ch = source[i]!;
    if (ch !== "[" && ch !== "]" && ch !== "," && !/[0-9\s]/.test(ch))
      return null;
    if (i - from > 24) return null;
    i++;
  }
  if (source[i] !== '"') return null;
  let value = "";
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j]!;
    if (ch !== "\\") {
      if (ch === '"') return value;
      value += ch;
      continue;
    }
    const next = source[j + 1];
    if (next === undefined) return null;
    if (next === "u") {
      const hex = source.slice(j + 2, j + 6);
      value += /^[0-9a-fA-F]{4}$/.test(hex)
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : "u";
      j += 5;
      continue;
    }
    if (next === "x") {
      const hex = source.slice(j + 2, j + 4);
      value += /^[0-9a-fA-F]{2}$/.test(hex)
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : "x";
      j += 3;
      continue;
    }
    value += unescapeChar(next);
    j += 1;
  }
  return null;
}

/** 单字符转义；未列出的转义退化为字符本身（`\"` `\\` `\/` 都走这条）。 */
function unescapeChar(next: string): string {
  switch (next) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    default:
      return next;
  }
}

/**
 * 标出「位于字符串字面量内部」的字符位置（1 = 内部）。
 *
 * Flight 载荷里同一个键名会出现在多个对象里（详情页实测 `"slug":"dsh-purge"`
 * 出现 3 次、`"type"` 出现在别处的 JSON-LD 里），因此**不能**用
 * 「第一个 `"key":"value"` 」这种字符串查找。花括号配平也必须知道哪些括号在
 * 字符串里。一次前向扫描拿到这张表，后续的前向/后向扫描都靠它。
 */
export function stringMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      mask[i] = 1;
      if (i + 1 < text.length) mask[i + 1] = 1;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = false;
      continue;
    }
    mask[i] = 1;
  }
  return mask;
}

/** 在字符串之外查找 needle；找不到返回 undefined。 */
export function findOutsideString(
  text: string,
  needle: string,
  mask: Uint8Array,
): number | undefined {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return undefined;
    if (mask[at] === 0) return at;
    from = at + 1;
  }
}

/** 从对象内部某位置向后找到其起始 `{`。 */
export function findObjectStart(
  text: string,
  inner: number,
  mask: Uint8Array,
): number | undefined {
  let depth = 0;
  for (let i = inner; i >= 0; i--) {
    if (mask[i] === 1) continue;
    const ch = text[i]!;
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return undefined;
}

/** 从对象起始 `{` 向后找到配平的结束 `}`。 */
export function findObjectEnd(
  text: string,
  start: number,
  mask: Uint8Array,
): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (mask[i] === 1) continue;
    const ch = text[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * 取出 `"key":{…}` 这个对象并 `JSON.parse`。
 *
 * Flight 载荷整体不是 JSON（含引用与多段流），但内嵌对象是：用花括号配平
 * 精确切出这一段即可解析，比在整段里做贪婪正则稳。
 *
 * ⚠️ 只在**键名唯一**时可用（`shardManifest` / `sidebarStats` 满足）。键名会
 * 重复的场景（详情页的 `install` / `compatibility`）必须改用
 * `findObjectStart` + 明确锚点，见 `site.ts` 的插件记录提取。
 */
export function readJsonObjectAfter(
  payload: string,
  key: string,
): unknown | undefined {
  const mask = stringMask(payload);
  const at = findOutsideString(payload, `"${key}":`, mask);
  if (at === undefined) return undefined;
  let i = at + key.length + 3;
  while (i < payload.length && /\s/.test(payload[i]!)) i++;
  if (payload[i] !== "{") return undefined;
  const end = findObjectEnd(payload, i, mask);
  if (end === undefined) return undefined;
  try {
    return JSON.parse(payload.slice(i, end + 1));
  } catch {
    return undefined;
  }
}