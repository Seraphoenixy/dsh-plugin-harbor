/**
 * 让 TypeScript 接受把 CSS 当成**字符串**导入。
 *
 * 构建侧对应 `scripts/build.mjs` 里 client 入口的 `loader: { ".css": "text" }`：
 * 若交给 esbuild 默认的 CSS 处理，`import css from "./client.css"` 会被抽成独立
 * 样式资源、默认导出一个空对象，页面就变成无样式。两处必须同时存在。
 *
 * 样式写在 `src/client.css` 而不是 client.ts 的模板字面量里：CSS 注释或内容中
 * 出现反引号会提前终止字符串（参考项目踩过 6 次）。
 */
declare module "*.css" {
  const text: string;
  export default text;
}