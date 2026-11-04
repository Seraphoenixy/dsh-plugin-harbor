"use strict";
(() => {
  // src/client.css
  var client_default = "/*\n * \u63D2\u4EF6\u6E2F\u6E7E\u6837\u5F0F\u3002\n *\n * \u7EA6\u5B9A\uFF08\u4E0E\u53C2\u8003\u9879\u76EE channel-hub \u540C\u53E3\u5F84\uFF09\uFF1A\n * - \u5168\u90E8\u7C7B\u540D\u4EE5 `pc` \u524D\u7F00\uFF0C\u5BBF\u4E3B\u4EE4\u724C `--dsw-alias-*` \u4F18\u5148\u3001\u7F3A\u7701\u503C\u515C\u5E95\uFF1B\n * - **\u9875\u9762\u672C\u8EAB\u4E0D\u6EDA\u52A8**\uFF0C\u53EA\u6709 `.pc-body` \u6EDA\u52A8\uFF1A`.pc` \u5FC5\u987B min-width/min-height:0\n *   + height:100% + overflow:hidden\uFF0C\u5426\u5219\u5BBF\u4E3B\u4E3B\u533A\u57DF\u91CC\u7684 flex:1 \u4F1A\u5931\u6548\u3001\u6574\u9875\u88AB\n *   \u5185\u5BB9\u6491\u9AD8\u6EDA\u8D70\uFF0C\u9875\u7B7E\u4E0D\u518D\u56FA\u5B9A\u3002\n * - \u989C\u8272\u4E0D\u505A\u786C\u7F16\u7801\uFF0C\u8DDF\u968F\u5BBF\u4E3B\u660E\u6697\u4E3B\u9898\u3002\n */\n.pc{\n  --pc-text:var(--dsw-alias-label-primary,var(--text-primary,inherit));\n  --pc-text-2:var(--dsw-alias-label-secondary,#6b7280);\n  --pc-text-3:var(--dsw-alias-label-tertiary,#9ca3af);\n  --pc-line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));\n  --pc-line-soft:var(--dsw-alias-border-l1,rgba(128,128,128,.16));\n  --pc-layer-1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n  --pc-layer-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));\n  --pc-accent:var(--dsw-alias-state-business-primary,#5785dd);\n  --pc-err:var(--dsw-alias-state-error-primary,#d55b5b);\n  --pc-ok:var(--dsw-alias-state-success-primary,#2f9e6b);\n  --pc-warn:var(--dsw-alias-state-warning-primary,#d6922f);\n  display:flex;\n  flex-direction:column;\n  gap:14px;\n  width:100%;\n  box-sizing:border-box;\n  color:var(--pc-text);\n  font-size:15px;\n  line-height:1.55;\n  min-width:0;\n  min-height:0;\n  height:100%;\n  padding:0 clamp(16px,2.4vw,40px) 0;\n  overflow:hidden;\n}\n.pc *{box-sizing:border-box}\n.pc h2,.pc h3,.pc p,.pc dl,.pc dd,.pc dt{margin:0}\n.pc h2{font-size:27px;line-height:1.2;font-weight:760;letter-spacing:-.02em}\n.pc h3{font-size:16px;line-height:1.35;font-weight:680}\n.pc-head{\n  display:flex;\n  align-items:flex-end;\n  justify-content:space-between;\n  gap:12px;\n  flex-wrap:wrap;\n  padding-top:22px;\n}\n.pc-title{display:flex;align-items:baseline;gap:10px;min-width:0}\n.pc-ver{color:var(--pc-text-3);font-size:13px;font-variant-numeric:tabular-nums}\n.pc-actions{display:flex;align-items:center;gap:8px}\n.pc-btn{\n  appearance:none;\n  border:1px solid var(--pc-line);\n  background:var(--pc-layer-1);\n  color:var(--pc-text);\n  border-radius:8px;\n  padding:6px 12px;\n  font-size:13.5px;\n  cursor:pointer;\n}\n.pc-btn:hover{background:var(--pc-layer-2)}\n.pc-tabs{\n  display:flex;\n  align-items:center;\n  gap:4px;\n  border-bottom:1px solid var(--pc-line-soft);\n  flex-wrap:wrap;\n}\n.pc-tab{\n  appearance:none;\n  border:0;\n  background:transparent;\n  color:var(--pc-text-2);\n  padding:8px 12px;\n  font-size:14px;\n  cursor:pointer;\n  border-bottom:2px solid transparent;\n}\n.pc-tab.is-on{color:var(--pc-text);border-bottom-color:var(--pc-accent);font-weight:620}\n.pc-body{\n  flex:1;\n  min-height:0;\n  overflow:auto;\n  display:flex;\n  flex-direction:column;\n  gap:12px;\n  padding-bottom:24px;\n}\n.pc-card{\n  border:1px solid var(--pc-line-soft);\n  border-radius:12px;\n  background:var(--pc-layer-1);\n  padding:14px 16px;\n  display:flex;\n  flex-direction:column;\n  gap:10px;\n}\n.pc-note{color:var(--pc-text-2);font-size:13.5px}\n.pc-error{\n  border:1px solid var(--pc-err);\n  border-radius:10px;\n  padding:10px 12px;\n  color:var(--pc-err);\n  font-size:13.5px;\n  word-break:break-word;\n}\n.pc-kv{display:grid;grid-template-columns:minmax(96px,auto) 1fr;gap:4px 14px}\n.pc-kv-row{display:contents}\n.pc-kv dt{color:var(--pc-text-3);font-size:13px}\n.pc-kv dd{\n  font-size:13px;\n  min-width:0;\n  overflow-wrap:anywhere;\n  font-variant-numeric:tabular-nums;\n}\n/* ---- \u5E02\u573A\u9875 ---- */\n.pc-market{\n  display:flex;\n  flex-direction:column;\n  gap:10px;\n  min-height:0;\n  flex:1;\n}\n.pc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.pc-search{\n  flex:1 1 240px;\n  min-width:180px;\n  appearance:none;\n  border:1px solid var(--pc-line);\n  background:var(--pc-layer-1);\n  color:var(--pc-text);\n  border-radius:8px;\n  padding:7px 11px;\n  font-size:13.5px;\n}\n.pc-search::placeholder{color:var(--pc-text-3)}\n.pc-select{\n  appearance:none;\n  border:1px solid var(--pc-line);\n  background:var(--pc-layer-1);\n  color:var(--pc-text);\n  border-radius:8px;\n  padding:7px 10px;\n  font-size:13.5px;\n}\n.pc-btn[disabled]{opacity:.55;cursor:default}\n/*\n * \u5206\u7C7B\u6761\uFF1A\u5141\u8BB8\u6A2A\u5411\u6EDA\u52A8\u800C\u4E0D\u662F\u628A\u5DE5\u5177\u680F\u6491\u7834\u3002\n * \u7236\u7EA7 `.pc-market` \u662F flex \u5217\uFF0C\u8FD9\u91CC\u5FC5\u987B min-width:0 \u624D\u4E0D\u4F1A\u628A\u6574\u9875\u9876\u5BBD\u3002\n */\n.pc-tabs.is-sub{\n  border-bottom:0;\n  gap:2px;\n  overflow-x:auto;\n  min-width:0;\n  padding-bottom:2px;\n}\n.pc-tabs.is-sub .pc-tab{padding:5px 9px;font-size:13px;white-space:nowrap}\n.pc-tabs.is-sub .pc-tab.is-on{background:var(--pc-layer-2);border-bottom-color:transparent;border-radius:7px}\n.pc-summary{\n  display:flex;\n  align-items:center;\n  gap:12px;\n  flex-wrap:wrap;\n  color:var(--pc-text-3);\n  font-size:12.5px;\n  font-variant-numeric:tabular-nums;\n}\n.pc-error-inline{color:var(--pc-err)}\n/*\n * \u5217\u8868\u5BB9\u5668\uFF1A**\u53EA\u6709\u5B83\u6EDA\u52A8**\u3002\n * \u7A97\u53E3\u5316\u6E32\u67D3\u4F9D\u8D56\u300C\u884C\u9AD8\u56FA\u5B9A + \u4E0A\u4E0B\u5360\u4F4D\u5757\u6491\u8D77\u6EDA\u52A8\u6761\u300D\uFF0C\u56E0\u6B64\u8FD9\u91CC\u4E0D\u8BBE\n * `scroll-behavior:smooth`\uFF0C\u4E5F\u4E0D\u5141\u8BB8\u884C\u9AD8\u968F\u5185\u5BB9\u53D8\u5316\uFF08\u63CF\u8FF0\u7528\u5355\u884C\u7701\u7565\uFF09\u3002\n */\n.pc-list{\n  flex:1;\n  min-height:0;\n  overflow:auto;\n  border:1px solid var(--pc-line-soft);\n  border-radius:12px;\n  background:var(--pc-layer-1);\n  padding:0 12px;\n}\n.pc-list-spacer{width:100%}\n.pc-row{\n  height:64px;\n  display:flex;\n  align-items:center;\n  gap:14px;\n  border-bottom:1px solid var(--pc-line-soft);\n  min-width:0;\n}\n.pc-row:last-of-type{border-bottom:0}\n.pc-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}\n.pc-row-title{display:flex;align-items:baseline;gap:8px;min-width:0}\n.pc-row-name{font-size:14px;font-weight:620;white-space:nowrap}\n.pc-row-repo{\n  color:var(--pc-text-3);\n  font-size:12px;\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n  min-width:0;\n}\n/*\n * \u53EF\u70B9\u7684\u4ED3\u5E93\u5730\u5740\uFF08\u5916\u94FE\uFF0C\u4EA4\u7ED9\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00\uFF09\u3002\n * \u7528\u4E0B\u5212\u7EBF\u800C\u4E0D\u662F\u53EA\u9760\u989C\u8272\uFF1A\u8272\u5F31\u7528\u6237\u4E5F\u8981\u80FD\u770B\u51FA\u8FD9\u662F\u94FE\u63A5\uFF1Bhover \u624D\u53D8\u4E3B\u9898\u8272\uFF0C\n * \u5E73\u65F6\u4FDD\u6301\u4E0E\u539F\u6765\u4E00\u81F4\u7684\u7070\uFF0C\u907F\u514D\u6574\u5217\u8868\u82B1\u6389\u3002\n */\n.pc-row-repo.is-link{\n  text-decoration:underline;\n  text-decoration-color:color-mix(in srgb,var(--pc-text-3) 55%,transparent);\n  text-underline-offset:2px;\n  cursor:pointer;\n}\n.pc-row-repo.is-link:hover{color:var(--pc-accent);text-decoration-color:currentColor}\n/* \u300C\u6E90\u7AD9\u300D\u6309\u94AE\u662F `<a>`\uFF1A\u53BB\u6389\u94FE\u63A5\u9ED8\u8BA4\u6837\u5F0F\uFF0C\u5916\u89C2\u4E0E\u76F8\u90BB\u6309\u94AE\u4E00\u81F4 */\na.pc-btn{display:inline-flex;align-items:center;text-decoration:none;line-height:1.5}\n.pc-row-desc{\n  color:var(--pc-text-2);\n  font-size:12.5px;\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n}\n.pc-row-meta{\n  display:flex;\n  align-items:center;\n  gap:8px;\n  flex:none;\n  color:var(--pc-text-3);\n  font-size:12px;\n  font-variant-numeric:tabular-nums;\n}\n.pc-chip{\n  border:1px solid var(--pc-line);\n  border-radius:999px;\n  padding:1px 7px;\n  font-size:11.5px;\n  white-space:nowrap;\n}\n.pc-chip.is-ok{color:var(--pc-ok);border-color:color-mix(in srgb,var(--pc-ok) 45%,transparent)}\n.pc-chip.is-warn{color:var(--pc-warn);border-color:color-mix(in srgb,var(--pc-warn) 45%,transparent)}\n.pc-chip.is-on{color:var(--pc-accent);border-color:color-mix(in srgb,var(--pc-accent) 45%,transparent)}\n.pc-chip.is-muted{color:var(--pc-text-3)}\n/* ---- \u5DF2\u88C5\u9875 ---- */\n.pc-summary-inline{color:var(--pc-text-2);font-size:13px}\n/*\n * \u5DF2\u88C5\u884C\u6BD4\u5E02\u573A\u884C\u9AD8\u4E00\u6863\uFF1A\u591A\u4E00\u884C\u7ED3\u8BBA/\u8BF4\u660E\u3002\n * \u26A0\uFE0F \u53EA\u6709\u5DF2\u88C5\u9875\u7528\u8FD9\u4E2A\u9AD8\u5EA6 \u2014\u2014 \u5E02\u573A\u5217\u8868\u7684\u7A97\u53E3\u5316\u4F9D\u8D56\u56FA\u5B9A 64px\uFF0C\u6539\u8FD9\u91CC\u4E0D\u5F71\u54CD\u5B83\u3002\n */\n.pc-row.is-tall{height:84px;align-items:flex-start;padding:10px 0}\n.pc-row-warn{color:var(--pc-err);font-size:12px;margin-top:1px}\n.pc-row-note{color:var(--pc-text-3);font-size:12px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n/* ---- \u53D8\u66F4\u6309\u94AE\u4E0E\u786E\u8BA4\u5F39\u7A97 ---- */\n.pc-btn.is-small{padding:3px 9px;font-size:12px}\n.pc-btn.is-primary{background:var(--pc-accent);border-color:var(--pc-accent);color:#fff}\n.pc-btn.is-danger{color:var(--pc-err);border-color:color-mix(in srgb,var(--pc-err) 45%,transparent)}\n.pc-chip.is-err{color:var(--pc-err);border-color:color-mix(in srgb,var(--pc-err) 45%,transparent)}\n/*\n * \u5F39\u7A97\uFF1A**\u56FA\u5B9A\u5728\u89C6\u53E3**\uFF0C\u4E0D\u53C2\u4E0E\u9762\u677F\u7684 flex \u5E03\u5C40 \u2014\u2014 \u9762\u677F\u672C\u8EAB overflow:hidden\uFF0C\n * \u653E\u5728\u5E03\u5C40\u91CC\u4F1A\u88AB\u88C1\u6389\u3002\n */\n.pc-overlay{\n  position:fixed;\n  inset:0;\n  background:rgba(0,0,0,.38);\n  display:flex;\n  align-items:center;\n  justify-content:center;\n  z-index:40;\n}\n.pc-dialog{\n  width:min(520px,92vw);\n  max-height:80vh;\n  overflow:auto;\n  background:var(--dsw-alias-bg-layer-3,var(--pc-layer-2,#1f2430));\n  border:1px solid var(--pc-line);\n  border-radius:14px;\n  padding:18px 20px;\n  display:flex;\n  flex-direction:column;\n  gap:10px;\n  box-shadow:0 18px 48px rgba(0,0,0,.35);\n}\n.pc-dialog-body{font-size:14px}\n.pc-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}\n/* ---- \u64CD\u4F5C\u9875 ---- */\n.pc-op{\n  border-bottom:1px solid var(--pc-line-soft);\n  padding:8px 0 10px;\n  display:flex;\n  flex-direction:column;\n  gap:5px;\n  min-width:0;\n}\n.pc-op:last-of-type{border-bottom:0}\n.pc-op-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}\n.pc-op-kind{color:var(--pc-text-3);font-size:12px}\n.pc-op-target{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.pc-op-time,.pc-op-progress{color:var(--pc-text-3);font-size:12px;font-variant-numeric:tabular-nums}\n.pc-op-progress{margin-left:auto}\n.pc-op-group{color:var(--pc-text-3);font-size:12px;font-weight:600;margin:10px 0 2px}\n/*\n * \u8FDB\u5EA6\u6761\uFF1A\u53EA\u505A\u5BBD\u5EA6\u52A8\u753B\uFF0C\u9AD8\u5EA6\u56FA\u5B9A \u2014\u2014 \u6709\u8FDB\u5EA6\u6761\u7684\u884C\u4E0D\u4F1A\u628A\u7A97\u53E3\u5316\u5217\u8868\u7684\u884C\u9AD8\u6491\u53D8\u3002\n */\n.pc-bar{height:4px;border-radius:999px;background:var(--pc-layer-2);overflow:hidden}\n.pc-bar-fill{height:100%;background:var(--pc-accent);transition:width .25s ease}\n.pc-op-log{\n  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;\n  font-size:11.5px;\n  line-height:1.5;\n  color:var(--pc-text-2);\n  background:var(--pc-layer-1);\n  border:1px solid var(--pc-line-soft);\n  border-radius:8px;\n  padding:8px 10px;\n  margin:0;\n  max-height:180px;\n  overflow:auto;\n  white-space:pre-wrap;\n  word-break:break-word;\n}\n/* ---- \u8BBE\u7F6E\u9875 ---- */\n.pc-card-head{display:flex;flex-direction:column;gap:2px}\n.pc-card-sub{color:var(--pc-text-3);font-size:12.5px}\n/*\n * \u8868\u5355\uFF1A\u81EA\u9002\u5E94\u4E24\u5217\uFF08\u7A84\u5BB9\u5668\u81EA\u52A8\u843D\u6210\u4E00\u5217\uFF09\u3002\n * \u26A0\uFE0F \u5B57\u6BB5\u63A7\u4EF6\u7528 `.pc-input` \u800C\u4E0D\u662F\u590D\u7528\u5E02\u573A\u9875\u7684 `.pc-search`\uFF1A\u540E\u8005\u5E26\n * `flex:1 1 240px` \u7684\u641C\u7D22\u6846\u8BED\u4E49\uFF0C\u653E\u8FDB\u7F51\u683C\u4F1A\u7B97\u9519\u5BBD\u5EA6\uFF08\u672C\u8F6E\u91CD\u505A\u65F6\u8E29\u5230\uFF09\u3002\n */\n.pc-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 16px}\n.pc-field{display:flex;flex-direction:column;gap:4px;min-width:0}\n.pc-field-label{color:var(--pc-text-2);font-size:13px;font-weight:560}\n.pc-field-hint{color:var(--pc-text-3);font-size:11.5px;line-height:1.45}\n.pc-input{\n  width:100%;\n  appearance:none;\n  border:1px solid var(--pc-line);\n  background:var(--pc-layer-1);\n  color:var(--pc-text);\n  border-radius:8px;\n  padding:7px 11px;\n  font-size:13.5px;\n  min-width:0;\n}\n.pc-input:focus{outline:none;border-color:var(--pc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--pc-accent) 22%,transparent)}\n.pc-input::placeholder{color:var(--pc-text-3)}\nselect.pc-input{cursor:pointer}\n/*\n * \u4FDD\u5B58\u6761\uFF1A\u53F3\u5BF9\u9F50\u52A8\u4F5C\uFF0C\u5DE6\u4FA7\u7559\u7ED9\u300C\u4FDD\u5B58\u5728\u54EA\u91CC / \u5DF2\u4FDD\u5B58\u300D\u3002\n * `.is-inline` \u53D8\u4F53\u7528\u4E8E\u5361\u7247\u5185\u90E8\uFF08\u53BB\u6389\u5916\u8FB9\u8DDD\uFF09\u3002\n */\n.pc-form-footer{\n  display:flex;\n  align-items:center;\n  gap:10px;\n  justify-content:flex-end;\n  margin:2px 0 4px;\n}\n.pc-form-footer .pc-field-hint{margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.pc-form-footer.is-inline{margin:0}\n.pc-ok-inline{color:var(--pc-ok);font-size:12.5px}\n.pc-note-block{\n  border:1px solid color-mix(in srgb,var(--pc-warn) 40%,transparent);\n  background:color-mix(in srgb,var(--pc-warn) 10%,transparent);\n  color:var(--pc-text-2);\n  border-radius:10px;\n  padding:9px 11px;\n  font-size:12.5px;\n}\n/* ---- \u8BCA\u65AD ---- */\n.pc-diag{display:flex;flex-direction:column;gap:2px}\n.pc-diag-row{\n  display:grid;\n  grid-template-columns:auto minmax(120px,150px) 1fr auto;\n  align-items:center;\n  gap:10px;\n  font-size:12.5px;\n  min-width:0;\n  padding:6px 8px;\n  border-radius:8px;\n}\n.pc-diag-row:nth-child(odd){background:var(--pc-layer-1)}\n.pc-diag-label{color:var(--pc-text-2);white-space:nowrap}\n.pc-diag-detail{\n  color:var(--pc-text-3);\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n  min-width:0;\n}";

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-plugin-harbor",
    factory: (require2) => {
      const React = require2("react");
      const h = React.createElement;
      const { useCallback, useEffect, useRef, useState } = React;
      const PANEL_ID = "plugin-harbor";
      const LABEL = "\u63D2\u4EF6\u6E2F\u6E7E";
      const BUILD = true ? "9c9f05e7a601" : "dev";
      globalThis.__PLUGIN_HARBOR_BUILD__ = BUILD;
      const TABS = [
        { id: "market", label: "\u5E02\u573A" },
        { id: "installed", label: "\u5DF2\u88C5" },
        { id: "ops", label: "\u64CD\u4F5C" },
        { id: "settings", label: "\u8BBE\u7F6E" }
      ];
      const ROW_HEIGHT = 64;
      const OVERSCAN = 6;
      const PAGE_SIZE = 50;
      const SEARCH_DEBOUNCE_MS = 250;
      const CATEGORY_LABELS = {
        interface: "\u754C\u9762\u4E0E\u4F53\u9A8C",
        session: "\u4F1A\u8BDD\u4E0E\u6D88\u606F",
        memory: "\u8BB0\u5FC6\u4E0E\u4E0A\u4E0B\u6587",
        tools: "\u5DE5\u5177\u4E0E\u80FD\u529B",
        agent: "\u6280\u80FD\u4E0E\u667A\u80FD\u4F53",
        workflow: "\u5DE5\u4F5C\u6D41\u4E0E\u81EA\u52A8\u5316",
        integration: "\u96C6\u6210\u4E0E\u8FDE\u63A5",
        model: "\u6A21\u578B\u4E0E\u63A8\u7406",
        dev: "\u5F00\u53D1\u4E0E\u8FD0\u7EF4",
        knowledge: "\u6570\u636E\u4E0E\u77E5\u8BC6",
        fun: "\u5A31\u4E50"
      };
      const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
      const SORTS = [
        { id: "stars", label: "\u6309 Star" },
        { id: "updated", label: "\u6700\u8FD1\u66F4\u65B0" },
        { id: "added", label: "\u6700\u65B0\u6536\u5F55" },
        { id: "name", label: "\u540D\u79F0" }
      ];
      const formatStars = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "\u2014";
      const KIND_LABELS = {
        registry: "npm \u5305",
        git: "GitHub \u4ED3\u5E93",
        path: "\u672C\u5730\u8DEF\u5F84",
        tarball: "\u538B\u7F29\u5305",
        unknown: "\u672A\u77E5\u6765\u6E90"
      };
      const kindLabel = (kind) => KIND_LABELS[String(kind)] ?? String(kind ?? "\u672A\u77E5\u6765\u6E90");
      function renderCheck(entry) {
        return h(
          "div",
          { className: "pc-diag-row", key: entry.id, "data-check": entry.id },
          h(
            "span",
            {
              className: "pc-chip " + (entry.ok === true ? "is-ok" : entry.ok === false ? "is-err" : "")
            },
            entry.ok === true ? "\u901A\u8FC7" : entry.ok === false ? "\u5931\u8D25" : "\u65E0\u7ED3\u8BBA"
          ),
          h("span", { className: "pc-diag-label" }, entry.label),
          h("span", { className: "pc-diag-detail", title: entry.detail }, entry.detail),
          h("span", { className: "pc-op-time" }, (entry.ms ?? 0) + "ms")
        );
      }
      const formatTime = (value) => typeof value === "number" && value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "\u2014";
      const effectText = (status) => {
        if (status?.hot === true) return "\u5BBF\u4E3B\u70ED\u91CD\u8F7D\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F DSH";
        if (status?.hot === false) return "\u8BE5 profile \u672A\u542F\u7528\u70ED\u91CD\u8F7D\uFF0C\u9700\u8981\u91CD\u542F DSH \u624D\u751F\u6548";
        return "\u662F\u5426\u8981\u91CD\u542F\u7531\u5BBF\u4E3B\u51B3\u5B9A\uFF08\u9762\u677F\u4F1A\u7167\u5B9E\u663E\u793A\uFF09";
      };
      const OP_STATUS = {
        queued: { label: "\u6392\u961F\u4E2D", tone: "" },
        running: { label: "\u8FDB\u884C\u4E2D", tone: "is-on" },
        done: { label: "\u5DF2\u5B8C\u6210", tone: "is-ok" },
        "restart-required": { label: "\u5F85\u91CD\u542F", tone: "is-warn" },
        failed: { label: "\u5931\u8D25", tone: "is-err" },
        cancelled: { label: "\u5DF2\u53D6\u6D88", tone: "" }
      };
      function OpRow({ task, onCancel }) {
        const status = OP_STATUS[task.status] ?? OP_STATUS.failed;
        const running = task.status === "running" || task.status === "queued";
        const shownSpec = task.installSpec ?? task.spec;
        return h(
          "div",
          { className: "pc-op", "data-task": task.id, "data-status": task.status },
          h(
            "div",
            { className: "pc-op-head" },
            h("span", { className: "pc-chip " + status.tone }, status.label),
            h("span", { className: "pc-op-kind" }, task.kind),
            h(
              "span",
              { className: "pc-op-target", title: shownSpec ?? task.target },
              shownSpec && shownSpec !== task.target ? `${task.target} \u2190 ${shownSpec}` : task.target
            ),
            h("span", { className: "pc-op-time" }, formatTime(task.endedAt ?? task.queuedAt)),
            typeof task.progress === "number" ? h("span", { className: "pc-op-progress" }, task.progress + "%") : null,
            running ? h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small",
                onClick: () => onCancel(task.id)
              },
              "\u53D6\u6D88"
            ) : null
          ),
          typeof task.progress === "number" && running ? h(
            "div",
            { className: "pc-bar" },
            h("div", { className: "pc-bar-fill", style: { width: task.progress + "%" } })
          ) : null,
          task.error ? h("p", { className: "pc-row-warn" }, task.error) : null,
          task.note ? h("p", { className: "pc-row-note" }, task.note) : null,
          task.log && task.log.length > 0 ? h(
            "pre",
            { className: "pc-op-log" },
            task.log.slice(-8).join("\n")
          ) : null
        );
      }
      function Ops({ ops, error, onCancel, busy }) {
        const tasks = Array.isArray(ops?.tasks) ? ops.tasks : [];
        const history = Array.isArray(ops?.history) ? ops.history : [];
        const live = tasks.filter(
          (task) => task.status === "queued" || task.status === "running"
        );
        const finished = tasks.filter(
          (task) => task.status !== "queued" && task.status !== "running"
        );
        return h(
          "div",
          { className: "pc-market" },
          h(
            "div",
            { className: "pc-summary" },
            h("span", null, `\u8FDB\u884C\u4E2D ${live.length}`),
            h("span", null, `\u672C\u6B21\u4F1A\u8BDD\u5DF2\u5B8C\u6210 ${finished.length}`),
            h("span", null, `\u5386\u53F2 ${history.length}`),
            busy ? h("span", null, "\u5237\u65B0\u4E2D\u2026") : null
          ),
          error ? h("p", { className: "pc-error" }, error) : null,
          h(
            "div",
            { className: "pc-list" },
            live.length === 0 && finished.length === 0 && history.length === 0 ? h(
              "p",
              { className: "pc-note" },
              "\u8FD8\u6CA1\u6709\u64CD\u4F5C\u8BB0\u5F55\u3002\u5728\u5E02\u573A\u9875\u70B9\u300C\u5B89\u88C5\u300D\u3001\u5728\u5DF2\u88C5\u9875\u70B9\u300C\u66F4\u65B0 / \u5378\u8F7D\u300D\u90FD\u4F1A\u8BB0\u5728\u8FD9\u91CC\u3002"
            ) : [
              live.length > 0 ? h("h4", { className: "pc-op-group", key: "live" }, "\u8FDB\u884C\u4E2D") : null,
              live.map(
                (task) => h(OpRow, { key: task.id, task, onCancel })
              ),
              finished.length > 0 ? h("h4", { className: "pc-op-group", key: "done" }, "\u672C\u6B21\u4F1A\u8BDD") : null,
              finished.map(
                (task) => h(OpRow, { key: task.id, task, onCancel })
              ),
              history.length > 0 ? h("h4", { className: "pc-op-group", key: "history" }, "\u5386\u53F2\u8BB0\u5F55\uFF08\u8DE8\u91CD\u542F\uFF09") : null,
              history.filter(
                (task) => !tasks.some((live2) => live2.id === task.id)
              ).map((task) => h(OpRow, { key: task.id, task, onCancel }))
            ]
          )
        );
      }
      function ConfirmDialog({ dialog, onClose }) {
        if (!dialog) return null;
        return h(
          "div",
          { className: "pc-overlay", role: "dialog", "aria-modal": "true" },
          h(
            "div",
            { className: "pc-dialog" },
            h("h3", null, dialog.title),
            h("p", { className: "pc-dialog-body" }, dialog.body),
            dialog.detail ? h("pre", { className: "pc-op-log" }, dialog.detail) : null,
            h(
              "div",
              { className: "pc-dialog-actions" },
              h(
                "button",
                { type: "button", className: "pc-btn", onClick: () => onClose(null) },
                "\u53D6\u6D88"
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-primary",
                  onClick: () => {
                    const action = dialog.action;
                    onClose(null);
                    action?.();
                  }
                },
                dialog.confirmLabel ?? "\u786E\u8BA4"
              )
            )
          )
        );
      }
      const DEFAULT_SITE_BASE = "https://dsh-plugin.org";
      function siteUrl(row, siteBase) {
        const owner = typeof row?.owner === "string" ? row.owner.trim() : "";
        const slug = typeof row?.slug === "string" ? row.slug.trim() : "";
        if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(slug)) return "";
        const base = normalizeSiteBase(siteBase);
        if (base === "") return "";
        return `${base}/zh/plugins/${owner}/${slug}`;
      }
      function normalizeSiteBase(value) {
        const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_SITE_BASE;
        try {
          const url = new URL(raw);
          if (url.protocol !== "https:" && url.protocol !== "http:") return "";
          if (url.username !== "" || url.password !== "") return "";
          return url.origin + url.pathname.replace(/\/+$/, "");
        } catch {
          return "";
        }
      }
      function CenterIcon(props) {
        const size = typeof props?.size === "number" ? props.size : 18;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            focusable: "false"
          },
          h("rect", { x: 3, y: 4, width: 18, height: 6.5, rx: 1.6 }),
          h("rect", { x: 3, y: 13.5, width: 7.5, height: 6.5, rx: 1.6 }),
          h("rect", { x: 13.5, y: 13.5, width: 7.5, height: 6.5, rx: 1.6 }),
          h("path", { d: "M6.6 7.2h10.8" })
        );
      }
      function kv(label, value) {
        const shown = value === void 0 || value === null || value === "" ? "\u2014" : String(value);
        return h(
          "div",
          { className: "pc-kv-row", key: label },
          h("dt", null, label),
          h("dd", { title: shown }, shown)
        );
      }
      function Row({ row, installed, onInstall, siteBase }) {
        const url = siteUrl(row, siteBase);
        return h(
          "div",
          { className: "pc-row", "data-repo": row.repo },
          h(
            "div",
            { className: "pc-row-main" },
            h(
              "div",
              { className: "pc-row-title" },
              h("span", { className: "pc-row-name" }, row.displayName || row.name),
              // owner/slug 不合法（拼不出安全地址）时退回纯文本：不给能执行脚本的 href
              url === "" ? h("span", { className: "pc-row-repo" }, row.repo) : h(
                "a",
                {
                  className: "pc-row-repo is-link",
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 dsh-plugin.org \u8BE6\u60C5\u9875\uFF1A" + url,
                  "data-open-site": row.repo
                },
                row.repo
              )
            ),
            h(
              "p",
              { className: "pc-row-desc", title: row.description },
              row.description || "\uFF08\u7AD9\u70B9\u672A\u63D0\u4F9B\u63CF\u8FF0\uFF09"
            )
          ),
          h(
            "div",
            { className: "pc-row-meta" },
            installed ? h("span", { className: "pc-chip is-on" }, "\u5DF2\u88C5") : null,
            h("span", { className: "pc-row-stars" }, "\u2605 " + formatStars(row.stars)),
            row.language ? h("span", { className: "pc-row-lang" }, row.language) : null,
            row.status === "verified" ? h("span", { className: "pc-chip is-ok" }, "\u5DF2\u9A8C\u8BC1") : row.status ? h("span", { className: "pc-chip" }, row.status) : null,
            /**
             * 除了点仓库名，再给一个显式按钮：仓库名那行字很小、又可能被省略号截断，
             * 明确写「详情页」的按钮更好找（两者指向同一个地址）。
             */
            url === "" ? null : h(
              "a",
              {
                className: "pc-btn is-small",
                href: url,
                target: "_blank",
                rel: "noopener noreferrer",
                title: "\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 dsh-plugin.org \u8BE6\u60C5\u9875\uFF1A" + url,
                "data-open-site-button": row.repo
              },
              "\u8BE6\u60C5\u9875"
            ),
            installed ? null : h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small",
                onClick: () => onInstall?.(row)
              },
              "\u5B89\u88C5"
            )
          )
        );
      }
      function Market({ call, installedRepos, onInstall, siteBase }) {
        const [state, setState] = useState({
          rows: [],
          total: null,
          facets: null,
          cursor: null,
          /** 输入框的即时值；`q` 是防抖后的实际查询词。 */
          qInput: "",
          q: "",
          category: "",
          sort: "stars",
          scrollTop: 0,
          viewportH: 560,
          busy: false,
          error: "",
          status: null,
          syncing: false
        });
        const listRef = useRef(null);
        const scrollFrame = useRef(0);
        const mounted = useRef(true);
        const patch = useCallback(
          (values) => setState((previous) => ({ ...previous, ...values })),
          []
        );
        const loadRows = useCallback(
          async (options = {}) => {
            const query = {
              q: options.q ?? state.q,
              category: options.category ?? state.category,
              sort: options.sort ?? state.sort,
              limit: PAGE_SIZE,
              ...options.cursor ? { cursor: options.cursor } : {}
            };
            try {
              const page = await call("catalog.list", query);
              if (!mounted.current) return;
              setState((previous) => ({
                ...previous,
                rows: options.reset ? page.rows : [...previous.rows, ...page.rows],
                total: page.total,
                facets: page.facets ?? previous.facets,
                cursor: page.nextCursor ?? null,
                busy: false
              }));
            } catch (cause) {
              patch({ busy: false, error: String(cause?.message ?? cause) });
            }
          },
          [call, state.q, state.category, state.sort, patch]
        );
        const loadRowsRef = useRef(null);
        loadRowsRef.current = loadRows;
        useEffect(() => {
          mounted.current = true;
          let cancelled = false;
          (async () => {
            try {
              const status = await call("catalog.status");
              if (cancelled || !mounted.current) return;
              patch({ status, syncing: Boolean(status?.syncing) });
              if ((status?.rows ?? 0) === 0 && !status?.syncing) {
                patch({ busy: true });
                const report = await call("catalog.refresh");
                if (cancelled || !mounted.current) return;
                patch({
                  error: report?.failures?.length > 0 ? "\u90E8\u5206\u5206\u7247\u53D6\u6570\u5931\u8D25\uFF1A" + report.failures[0].reason : "",
                  syncing: false
                });
              }
              await loadRowsRef.current?.({ reset: true });
            } catch (cause) {
              patch({ busy: false, error: String(cause?.message ?? cause) });
            }
          })();
          return () => {
            cancelled = true;
            mounted.current = false;
          };
        }, [call, patch]);
        useEffect(() => {
          if (state.qInput === state.q) return void 0;
          const timer = setTimeout(() => {
            patch({ q: state.qInput, rows: [], cursor: null });
          }, SEARCH_DEBOUNCE_MS);
          return () => clearTimeout(timer);
        }, [state.qInput, state.q, patch]);
        const queryKey = state.q + "\0" + state.category + "\0" + state.sort;
        const lastKey = useRef("");
        useEffect(() => {
          if (lastKey.current === "") {
            lastKey.current = queryKey;
            return;
          }
          if (lastKey.current === queryKey) return;
          lastKey.current = queryKey;
          patch({ busy: true, error: "" });
          loadRows({
            reset: true,
            q: state.q,
            category: state.category,
            sort: state.sort
          });
        }, [queryKey, patch, loadRows, state.q, state.category, state.sort]);
        useEffect(() => {
          const element = listRef.current;
          if (!element || typeof ResizeObserver === "undefined") return void 0;
          const observer = new ResizeObserver(() => {
            const height = element.clientHeight;
            if (height > 0)
              setState(
                (previous) => previous.viewportH === height ? previous : { ...previous, viewportH: height }
              );
          });
          observer.observe(element);
          return () => observer.disconnect();
        }, []);
        const onScroll = useCallback(
          (event) => {
            const top = event?.currentTarget?.scrollTop ?? 0;
            if (typeof requestAnimationFrame !== "function") {
              patch({ scrollTop: top });
              return;
            }
            if (scrollFrame.current) return;
            scrollFrame.current = requestAnimationFrame(() => {
              scrollFrame.current = 0;
              patch({ scrollTop: top });
            });
          },
          [patch]
        );
        const rows = state.rows;
        const rowsPerScreen = Math.ceil(state.viewportH / ROW_HEIGHT);
        const windowSize = rowsPerScreen + OVERSCAN * 2;
        const start = Math.max(0, Math.floor(state.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const end = Math.min(rows.length, start + windowSize);
        const visible = rows.slice(start, end);
        const nearEnd = end + rowsPerScreen >= rows.length;
        useEffect(() => {
          if (!nearEnd || state.busy || !state.cursor) return;
          patch({ busy: true });
          loadRows({ cursor: state.cursor });
        }, [nearEnd, state.busy, state.cursor, loadRows, patch]);
        const facets = state.facets;
        const categories = CATEGORY_ORDER.filter(
          (key) => (facets?.category?.[key] ?? 0) > 0
        );
        return h(
          "div",
          { className: "pc-market" },
          h(
            "div",
            { className: "pc-toolbar" },
            h("input", {
              className: "pc-search",
              type: "search",
              placeholder: "\u641C\u7D22\u63D2\u4EF6\u540D\u79F0\u3001\u63CF\u8FF0\u3001\u6807\u7B7E\u2026",
              value: state.qInput,
              "aria-label": "\u641C\u7D22\u63D2\u4EF6",
              onChange: (event) => patch({ qInput: event?.target?.value ?? "" })
            }),
            h(
              "select",
              {
                className: "pc-select",
                value: state.sort,
                "aria-label": "\u6392\u5E8F\u65B9\u5F0F",
                onChange: (event) => patch({ sort: event?.target?.value ?? "stars" })
              },
              SORTS.map((sort) => h("option", { key: sort.id, value: sort.id }, sort.label))
            ),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                disabled: state.busy || state.syncing,
                onClick: async () => {
                  patch({ busy: true, error: "" });
                  try {
                    const report = await call("catalog.refresh");
                    await loadRowsRef.current?.({ reset: true });
                    patch({
                      busy: false,
                      error: report?.failures?.length > 0 ? "\u90E8\u5206\u5206\u7247\u53D6\u6570\u5931\u8D25\uFF1A" + report.failures[0].reason : ""
                    });
                  } catch (cause) {
                    patch({ busy: false, error: String(cause?.message ?? cause) });
                  }
                }
              },
              state.syncing ? "\u540C\u6B65\u4E2D\u2026" : "\u5237\u65B0\u76EE\u5F55"
            )
          ),
          h(
            "div",
            { className: "pc-tabs is-sub" },
            h(
              "button",
              {
                key: "all",
                type: "button",
                className: "pc-tab" + (state.category === "" ? " is-on" : ""),
                onClick: () => patch({ category: "", rows: [], cursor: null })
              },
              "\u5168\u90E8"
            ),
            categories.map(
              (key) => h(
                "button",
                {
                  key,
                  type: "button",
                  className: "pc-tab" + (state.category === key ? " is-on" : ""),
                  onClick: () => patch({ category: key, rows: [], cursor: null })
                },
                CATEGORY_LABELS[key] ?? key
              )
            )
          ),
          h(
            "div",
            { className: "pc-summary" },
            state.error ? h("span", { className: "pc-error-inline" }, state.error) : null,
            h(
              "span",
              null,
              state.total === null ? "\u5C1A\u672A\u53D6\u5F97\u76EE\u5F55" : `\u5171 ${state.total.toLocaleString("zh-CN")} \u6761`
            ),
            h("span", null, `\u5DF2\u8F7D\u5165 ${rows.length} \u6761`),
            state.status?.lastSyncAt ? h(
              "span",
              null,
              "\u540C\u6B65\u4E8E " + new Date(state.status.lastSyncAt).toLocaleString("zh-CN")
            ) : h("span", null, "\u5C1A\u672A\u540C\u6B65"),
            state.busy ? h("span", null, "\u8BFB\u53D6\u4E2D\u2026") : null
          ),
          h(
            "div",
            { className: "pc-list", ref: listRef, onScroll },
            rows.length === 0 ? h(
              "p",
              { className: "pc-note" },
              state.busy ? "\u6B63\u5728\u4ECE dsh-plugin.org \u62C9\u53D6\u76EE\u5F55\u2026\uFF08\u9996\u6B21\u7EA6 19MB\uFF0C\u671F\u95F4\u53EF\u7EE7\u7EED\u7528\u5176\u4ED6\u529F\u80FD\uFF09" : "\u6CA1\u6709\u5339\u914D\u7684\u63D2\u4EF6\u3002"
            ) : [
              h("div", {
                key: "top",
                className: "pc-list-spacer",
                style: { height: start * ROW_HEIGHT + "px" }
              }),
              visible.map(
                (row) => h(Row, {
                  key: row.repo,
                  row,
                  installed: installedRepos?.has?.(row.repo) === true,
                  onInstall,
                  siteBase
                })
              ),
              h("div", {
                key: "bottom",
                className: "pc-list-spacer",
                style: { height: (rows.length - end) * ROW_HEIGHT + "px" }
              })
            ]
          )
        );
      }
      function Installed({
        call,
        installed,
        error,
        onReload,
        onUpdate,
        onHotReload,
        onRemove,
        onToggle,
        siteBase
      }) {
        const [state, setState] = useState({ busy: false, error: "" });
        const [transfer, setTransfer] = useState(false);
        const rows = Array.isArray(installed) ? installed : [];
        const counts = { update: 0, latest: 0, unknown: 0 };
        let lastChecked = 0;
        for (const row of rows) {
          const verdict = row?.update?.updateAvailable;
          if (verdict === true) counts.update += 1;
          else if (verdict === false) counts.latest += 1;
          else counts.unknown += 1;
          const at = row?.update?.checkedAt ?? 0;
          if (at > lastChecked) lastChecked = at;
        }
        const check = async () => {
          setState({ busy: true, error: "" });
          try {
            await call("updates.check");
            await onReload?.();
            setState({ busy: false, error: "" });
          } catch (cause) {
            setState({ busy: false, error: String(cause?.message ?? cause) });
          }
        };
        return h(
          "div",
          { className: "pc-market" },
          h(
            "div",
            { className: "pc-toolbar" },
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                disabled: state.busy,
                onClick: check
              },
              state.busy ? "\u68C0\u67E5\u4E2D\u2026" : "\u68C0\u67E5\u66F4\u65B0"
            ),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                onClick: () => setTransfer((value) => !value)
              },
              transfer ? "\u6536\u8D77\u5BFC\u51FA / \u5BFC\u5165" : "\u5BFC\u51FA / \u5BFC\u5165"
            ),
            h("span", { className: "pc-summary-inline" }, `\u5DF2\u88C5 ${rows.length} \u4E2A\u63D2\u4EF6`)
          ),
          transfer ? h(Transfer, { call, onDone: onReload }) : null,
          transfer ? h(GitSyncPanel, { call, onDone: onReload }) : null,
          h(
            "div",
            { className: "pc-summary" },
            h("span", null, `\u53EF\u66F4\u65B0 ${counts.update}`),
            h("span", null, `\u5DF2\u6700\u65B0 ${counts.latest}`),
            h("span", null, `\u672A\u5224\u5B9A ${counts.unknown}`),
            lastChecked > 0 ? h(
              "span",
              null,
              "\u68C0\u67E5\u4E8E " + new Date(lastChecked).toLocaleString("zh-CN")
            ) : h("span", null, "\u5C1A\u672A\u68C0\u67E5")
          ),
          error || state.error ? h("p", { className: "pc-error" }, error || state.error) : null,
          h(
            "div",
            { className: "pc-list" },
            rows.length === 0 ? h(
              "p",
              { className: "pc-note" },
              "\u8FD9\u4E2A profile \u91CC\u6CA1\u6709\u7B2C\u4E09\u65B9\u63D2\u4EF6\uFF08\u5BBF\u4E3B\u81EA\u5E26\u5305\u4E0D\u7B97\uFF09\u3002"
            ) : rows.map(
              (row) => h(InstalledRow, {
                key: row.name,
                row,
                onUpdate,
                onHotReload,
                onRemove,
                onToggle,
                siteBase
              })
            )
          )
        );
      }
      const cardHead = (title, sub) => h(
        "header",
        { className: "pc-card-head" },
        h("h3", null, title),
        h("p", { className: "pc-card-sub" }, sub)
      );
      function Transfer({ call, onDone }) {
        const [includeData, setIncludeData] = useState(false);
        const [busy, setBusy] = useState("");
        const [error, setError] = useState("");
        const [exported, setExported] = useState(null);
        const [files, setFiles] = useState([]);
        const [chosen, setChosen] = useState("");
        const [custom, setCustom] = useState("");
        const [preview, setPreview] = useState(null);
        const [imported, setImported] = useState(null);
        const [picked, setPicked] = useState(null);
        const fileInput = useRef(null);
        const loadFiles = useCallback(async () => {
          try {
            const rows = await call("export.list");
            const list = Array.isArray(rows) ? rows : [];
            setFiles(list);
            setChosen((current) => current || list[0]?.name || "");
          } catch (cause) {
            setError(String(cause?.message ?? cause));
          }
        }, [call]);
        useEffect(() => {
          loadFiles();
        }, [loadFiles]);
        const source = picked !== null ? picked.path : custom.trim() !== "" ? custom.trim() : chosen;
        const previewOf = useCallback(
          async (path) => {
            setBusy("preview");
            setError("");
            setImported(null);
            try {
              setPreview(await call("import.preview", { path }));
            } catch (cause) {
              setPreview(null);
              setError(String(cause?.message ?? cause));
            } finally {
              setBusy("");
            }
          },
          [call]
        );
        const pickFile = useCallback(
          async (file) => {
            if (!file) return;
            setBusy("pick");
            setError("");
            setPreview(null);
            setImported(null);
            try {
              const text = await file.text();
              const saved = await call("import.upload", { name: file.name, content: text });
              setPicked(saved);
              await loadFiles();
              await previewOf(saved.path);
            } catch (cause) {
              setPicked(null);
              setPreview(null);
              setError(String(cause?.message ?? cause));
            } finally {
              setBusy("");
            }
          },
          [call, loadFiles, previewOf]
        );
        const runExport = useCallback(async () => {
          setBusy("export");
          setError("");
          try {
            const result = await call("export.run", { includeData, confirm: true });
            setExported(result);
            setPreview(null);
            await loadFiles();
          } catch (cause) {
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy("");
          }
        }, [call, includeData, loadFiles]);
        const runPreview = useCallback(async () => await previewOf(source), [previewOf, source]);
        const runImport = useCallback(async () => {
          setBusy("import");
          setError("");
          try {
            const task = await call("op.import", { path: source, confirm: true });
            setImported(task);
            setPreview(null);
            await onDone?.();
          } catch (cause) {
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy("");
          }
        }, [call, source, onDone]);
        const plan = preview?.plan;
        return h(
          "section",
          { className: "pc-card", "data-transfer": "1" },
          cardHead("\u5BFC\u51FA / \u5BFC\u5165", "\u628A\u5DF2\u88C5\u63D2\u4EF6\u4E0E\u5B83\u4EEC\u7684\u914D\u7F6E\u5E26\u8D70\uFF1A\u5BFC\u51FA\u5230\u6587\u4EF6\uFF0C\u6216\u6309\u5BFC\u51FA\u6062\u590D"),
          h(
            "div",
            { className: "pc-field" },
            h("span", { className: "pc-field-label" }, "\u5BFC\u51FA"),
            h(
              "div",
              { className: "pc-form-footer is-inline" },
              h(
                "label",
                { className: "pc-field-hint" },
                h("input", {
                  type: "checkbox",
                  checked: includeData,
                  onChange: (event) => setIncludeData(Boolean(event?.target?.checked))
                }),
                " \u540C\u65F6\u5BFC\u51FA\u5404\u63D2\u4EF6\u81EA\u5DF1\u7684\u8BBE\u7F6E\u6587\u4EF6\uFF08\u8131\u654F\uFF1A\u7591\u4F3C\u51ED\u636E\u66FF\u6362\u4E3A [\u5DF2\u8131\u654F]\uFF1B\u6570\u636E\u5E93 / \u7F13\u5B58 / \u65E5\u5FD7 / \u4E8C\u8FDB\u5236\u4E0D\u5BFC\u51FA\uFF09"
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pc-btn",
                  disabled: busy === "export",
                  onClick: runExport
                },
                busy === "export" ? "\u5BFC\u51FA\u4E2D\u2026" : "\u5BFC\u51FA\u5230\u6587\u4EF6"
              )
            ),
            exported ? h(
              "div",
              { className: "pc-note-block" },
              h("p", null, `\u5DF2\u5BFC\u51FA ${exported.plugins} \u4E2A\u63D2\u4EF6\uFF08${exported.bytes} \u5B57\u8282\uFF09\u2192 ${exported.path}`),
              exported.files > 0 ? h("p", null, `\u542B ${exported.files} \u4E2A\u63D2\u4EF6\u8BBE\u7F6E\u6587\u4EF6\uFF08\u5DF2\u8131\u654F\uFF09`) : null,
              exported.omissions?.length > 0 ? h(
                "p",
                null,
                `\u672A\u5BFC\u51FA ${exported.omissions.length} \u9879\uFF08\u6570\u636E\u5E93 / \u7F13\u5B58 / \u8BA4\u4E0D\u51FA\u5F52\u5C5E\u7B49\uFF09\uFF0C\u660E\u7EC6\u5728\u6587\u4EF6\u7684 omissions \u91CC`
              ) : null,
              (exported.warnings ?? []).map(
                (line) => h("p", { key: line, className: "pc-field-hint" }, "\xB7 " + line)
              )
            ) : null
          ),
          h(
            "div",
            { className: "pc-field" },
            h("span", { className: "pc-field-label" }, "\u5BFC\u5165"),
            h(
              "div",
              { className: "pc-toolbar" },
              /**
               * 「选择文件…」是主入口：真实的 `<input type="file">` 交给浏览器弹文件浏览器，
               * 面板只负责把内容交给服务端落盘（`import.upload`）再预检。
               *
               * 样式上把 input 藏起来、用按钮代理点击 —— 原生 file 控件在各平台的宽度与
               * 按钮文案都不受控，放进来会把这一行撑变形；但它必须真的在 DOM 里且可点，
               * 否则脚本化的 click 在部分浏览器里不弹框。
               */
              h("input", {
                ref: fileInput,
                type: "file",
                accept: ".json,application/json",
                "data-pick": "1",
                style: { display: "none" },
                onChange: (event) => {
                  const file = event?.target?.files?.[0];
                  if (event?.target) event.target.value = "";
                  void pickFile(file);
                }
              }),
              h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-primary",
                  disabled: busy !== "",
                  onClick: () => fileInput.current?.click()
                },
                busy === "pick" ? "\u8BFB\u53D6\u4E2D\u2026" : "\u9009\u62E9\u6587\u4EF6\u2026"
              ),
              h(
                "select",
                {
                  className: "pc-input",
                  value: chosen,
                  onChange: (event) => {
                    setPicked(null);
                    setCustom("");
                    setChosen(String(event?.target?.value ?? ""));
                  }
                },
                files.length === 0 ? h("option", { value: "" }, "\uFF08\u5BFC\u51FA\u76EE\u5F55\u91CC\u8FD8\u6CA1\u6709\u6587\u4EF6\uFF09") : files.map(
                  (file) => h(
                    "option",
                    { key: file.name, value: file.name },
                    `${file.name}\uFF08${Math.round(file.bytes / 1024)}KB\uFF09`
                  )
                )
              ),
              h("input", {
                className: "pc-input",
                placeholder: "\u6216\u586B\u522B\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u4F8B\u5982\u4ECE\u53E6\u4E00\u53F0\u673A\u5668\u62F7\u6765\u7684\u5BFC\u51FA\u6587\u4EF6\uFF09",
                value: custom,
                onChange: (event) => {
                  setPicked(null);
                  setCustom(String(event?.target?.value ?? ""));
                }
              }),
              h(
                "button",
                {
                  type: "button",
                  className: "pc-btn",
                  disabled: busy !== "" || source === "",
                  onClick: runPreview
                },
                busy === "preview" ? "\u9884\u68C0\u4E2D\u2026" : "\u9884\u68C0"
              )
            ),
            picked !== null ? h(
              "span",
              { className: "pc-field-hint", "data-picked": "1" },
              `\u5DF2\u9009\u62E9\uFF1A${picked.name}\uFF08${Math.round(picked.bytes / 1024)}KB\uFF09\u2014\u2014 \u5DF2\u5B58\u5165\u672C\u63D2\u4EF6\u7684\u5BFC\u51FA\u76EE\u5F55\uFF0C\u53EF\u76F4\u63A5\u9884\u68C0\u6216\u5BFC\u5165`
            ) : null,
            h(
              "span",
              { className: "pc-field-hint" },
              "\u5BFC\u5165\u53EA\u589E\u4E0D\u5220\uFF1A\u53EA\u88C5\u7F3A\u5931\u7684\u3001\u6309\u5BFC\u51FA\u6062\u590D\u542F\u7528\u72B6\u6001\uFF1B\u4E0D\u4F1A\u5378\u8F7D\u4EFB\u4F55\u63D2\u4EF6\uFF0C\u4E5F\u4E0D\u6539 profile \u7684 package.json / cordis.patch.yml\u3002"
            ),
            plan ? h(PlanView, { plan }) : null,
            plan && plan.steps?.length > 0 ? h(
              "button",
              {
                type: "button",
                className: "pc-btn is-primary",
                disabled: busy === "import",
                onClick: runImport
              },
              busy === "import" ? "\u5DF2\u4E0B\u53D1\u2026" : "\u5F00\u59CB\u5BFC\u5165"
            ) : null,
            preview?.snippet ? h(
              "span",
              { className: "pc-field-hint" },
              `\u6CE8\u610F\uFF1A\u5BFC\u51FA\u91CC\u6709 ${plan?.configRows ?? 0} \u884C\u5E26 config \u7684\u8865\u4E01\u884C \u2014\u2014 \u5BBF\u4E3B\u6CA1\u6709\u5199 config \u7684\u63A5\u53E3\uFF0C\u5F00\u59CB\u5BFC\u5165\u540E\u4F1A\u751F\u6210\u4E00\u4EFD YAML \u7247\u6BB5\u6587\u4EF6\uFF0C\u9700\u8981\u4F60\u786E\u8BA4\u540E\u81EA\u884C\u7C98\u8D34\u5230 profile \u7684 cordis.patch.yml\u3002`
            ) : null,
            imported ? h(
              "div",
              { className: "pc-note-block" },
              h("p", null, `\u5DF2\u52A0\u5165\u64CD\u4F5C\u961F\u5217\uFF1A${imported.note ?? ""}`),
              h("p", { className: "pc-field-hint" }, "\u8FDB\u5EA6\u4E0E\u9010\u9879\u7ED3\u679C\u5728\u300C\u64CD\u4F5C\u300D\u9875\uFF1B\u5BFC\u5165\u4E0D\u963B\u585E\u8FD9\u4E2A\u9762\u677F\u3002")
            ) : null
          ),
          error ? h("p", { className: "pc-error" }, error) : null
        );
      }
      function GitSyncPanel({ call, onDone }) {
        const [remote, setRemote] = useState("");
        const [environment, setEnvironment] = useState("default");
        const [saved, setSaved] = useState("");
        const [preview, setPreview] = useState(null);
        const [busy, setBusy] = useState(false);
        const [message, setMessage] = useState("");
        const [error, setError] = useState("");
        const [dialog, setDialog] = useState(null);
        useEffect(() => {
          let active = true;
          call("sync.get").then((r) => {
            if (!active || !r.config) return;
            setRemote(r.config.remote);
            setEnvironment(r.config.environment);
            setSaved(JSON.stringify(r.config));
          }).catch((e) => {
            if (active) setError(String(e.message ?? e));
          });
          return () => {
            active = false;
          };
        }, [call]);
        const run = async (method, payload = {}) => {
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const result = await call(method, payload);
            if (method === "sync.configure") {
              setSaved(JSON.stringify(result.config));
              setPreview(null);
              setMessage("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u5C1A\u672A\u8054\u7F51");
            }
            if (method === "sync.preview") setPreview(result);
            if (method === "sync.publish") {
              setPreview(null);
              setMessage(result.unchanged ? "\u8FDC\u7AEF\u5185\u5BB9\u5DF2\u4E00\u81F4\uFF0C\u65E0\u9700\u65B0\u63D0\u4EA4" : `\u5FEB\u7167\u5DF2\u53D1\u5E03\uFF1A${result.commit}`);
            }
            if (method === "sync.apply") {
              setPreview(null);
              setMessage("\u5DF2\u52A0\u5165\u64CD\u4F5C\u961F\u5217\uFF1B\u666E\u901A\u914D\u7F6E\u5C06\u7531\u5BBF\u4E3B\u81EA\u52A8\u5408\u5E76\uFF0C\u9010\u9879\u7ED3\u679C\u8BF7\u67E5\u770B\u64CD\u4F5C\u9875");
              await onDone?.();
            }
          } catch (e) {
            setError(String(e.message ?? e));
          } finally {
            setBusy(false);
          }
        };
        const matches = saved === JSON.stringify({ remote, environment });
        const button = (label, action, disabled = false) => h("button", { type: "button", className: "pc-btn", disabled: busy || disabled, onClick: action }, label);
        return h(
          "section",
          { className: "pc-card", "data-git-sync": "1" },
          cardHead("Git \u8DE8\u673A\u5668\u540C\u6B65", "\u53EF\u4E0E Mnemon \u5171\u7528\u4ED3\u5E93\uFF1B\u4F7F\u7528\u72EC\u7ACB harbor-sync \u5206\u652F\u3002\u6253\u5F00\u9762\u677F\u4E0D\u8054\u7F51\u3002"),
          h("label", { className: "pc-field" }, "\u4ED3\u5E93\u5730\u5740", h("input", { className: "pc-input", value: remote, disabled: busy, placeholder: "https://github.com/you/private-backup.git", onChange: (e) => {
            setRemote(e.target.value);
            setPreview(null);
          } })),
          h("label", { className: "pc-field" }, "\u5171\u4EAB\u73AF\u5883\u540D", h("input", { className: "pc-input", value: environment, disabled: busy, onChange: (e) => {
            setEnvironment(e.target.value);
            setPreview(null);
          } })),
          h("p", { className: "pc-field-hint" }, "\u4E0D\u540C\u673A\u5668\u586B\u5199\u76F8\u540C\u4ED3\u5E93\u4E0E\u73AF\u5883\u540D\u3002\u4F7F\u7528\u7CFB\u7EDF Git \u7684 SSH \u6216\u51ED\u636E\u7BA1\u7406\u5668\uFF1B\u5EFA\u8BAE\u4F7F\u7528\u79C1\u6709\u4ED3\u5E93\u3002\u914D\u7F6E\u8131\u654F\u540E\u53D1\u5E03\uFF0C\u51ED\u636E\u9700\u5728\u76EE\u6807\u673A\u5668\u5355\u72EC\u586B\u5199\u3002"),
          h(
            "div",
            { className: "pc-form-footer is-inline" },
            button("\u4FDD\u5B58\u8BBE\u7F6E", () => setDialog({ title: "\u4FDD\u5B58 Git \u540C\u6B65\u8BBE\u7F6E", body: "\u4EC5\u4FDD\u5B58\u672C\u673A\u8BBE\u7F6E\uFF0C\u4E0D\u8054\u7F51\u3002", detail: `${remote}
\u5206\u652F\uFF1Aharbor-sync
\u73AF\u5883\uFF1A${environment}`, action: () => run("sync.configure", { remote, environment, confirm: true }) })),
            button("\u68C0\u67E5\u8FDC\u7AEF\u5E76\u9884\u68C0", () => run("sync.preview"), !matches),
            busy ? h("button", { type: "button", className: "pc-btn", onClick: () => call("sync.cancel").catch(() => {
            }) }, "\u53D6\u6D88 Git \u64CD\u4F5C") : null
          ),
          preview && matches ? h(
            "div",
            { className: "pc-note-block" },
            h("p", null, preview.hasRemote ? `\u8FDC\u7AEF\u5FEB\u7167\uFF1A${preview.commit}\uFF1B${preview.same ? "\u5185\u5BB9\u4E00\u81F4" : "\u5B58\u5728\u5DEE\u5F02"}` : "\u8FDC\u7AEF\u5C1A\u65E0\u6B64\u73AF\u5883\u5FEB\u7167\uFF0C\u53EF\u53D1\u5E03\u672C\u673A\u73AF\u5883"),
            h(
              "details",
              null,
              h("summary", null, `\u672C\u673A\u5F85\u53D1\u5E03\uFF1A${preview.local.plugins.length} \u4E2A\u63D2\u4EF6\uFF0C${preview.local.configRows} \u884C\u914D\u7F6E`),
              h("pre", { className: "pc-op-log" }, preview.local.plugins.map((p) => `${p.name} ${p.version ?? "\u7248\u672C\u672A\u77E5"} ${p.enabled ? "\u542F\u7528" : "\u505C\u7528"}`).join("\n")),
              h("details", null, h("summary", null, "\u5B8C\u6574\u5F85\u53D1\u5E03\u5FEB\u7167\uFF08\u542B\u8131\u654F\u914D\u7F6E\uFF09"), h("pre", { className: "pc-op-log" }, preview.local.snapshot)),
              h("p", null, "\u672A\u5BFC\u51FA\u9879\uFF1A"),
              ...preview.local.omissions.map((x, i) => h("p", { key: i }, `${x.path}\uFF1A${x.reason}`)),
              ...preview.local.warnings.map((x, i) => h("p", { key: "w" + i }, x))
            ),
            preview.plan ? h(PlanView, { plan: preview.plan }) : null,
            ...preview.versions.map((x, i) => h("p", { key: i }, x)),
            ...(preview.configPlans ?? []).map((p, i) => h(
              "p",
              { key: "config" + i, className: "pc-field-hint" },
              `${p.plugin} / ${p.id || "\u65E0\u6761\u76EE ID"}\uFF1A${p.action === "apply" ? "\u81EA\u52A8\u5408\u5E76 " + p.paths.join("\u3001") : p.action === "skip" ? "\u4FDD\u7559\u672C\u673A\u914D\u7F6E" : "\u9700\u4EBA\u5DE5\u5904\u7406"}${p.reason ? "\uFF08" + p.reason + "\uFF09" : ""}${p.skipped.length ? "\uFF1B\u51ED\u636E\u3001\u8DEF\u5F84\u7B49\u53D7\u4FDD\u62A4\u5B57\u6BB5\u5DF2\u8DF3\u8FC7 " + p.skipped.length + " \u9879" : ""}`
            )),
            preview.snippet && preview.configPlans?.some((p) => p.action === "manual") ? h(
              "details",
              null,
              h("summary", null, "\u672A\u81EA\u52A8\u5E94\u7528\u7684\u914D\u7F6E\uFF08\u67E5\u770B\u539F\u56E0\u4E0E\u7247\u6BB5\uFF09"),
              ...preview.configPlans.filter((p) => p.action === "manual").map((p, i) => h("p", { key: i }, `${p.plugin} / ${p.id || "\u65E0\u6761\u76EE ID"}\uFF1A${p.reason || "\u65E0\u6CD5\u5B89\u5168\u81EA\u52A8\u5E94\u7528"}`)),
              h("pre", { className: "pc-op-log" }, preview.snippet)
            ) : null,
            preview.snippet && !Array.isArray(preview.configPlans) ? h("p", { className: "pc-field-hint" }, "\u5F53\u524D\u8FD0\u884C\u7684\u670D\u52A1\u7AEF\u5C1A\u672A\u8FD4\u56DE\u81EA\u52A8\u914D\u7F6E\u8BA1\u5212\uFF0C\u672C\u6B21\u9884\u68C0\u65E0\u6CD5\u786E\u8BA4\u81EA\u52A8\u5E94\u7528\u80FD\u529B\u3002") : null,
            h("p", { className: "pc-field-hint" }, "\u53D1\u5E03\u4F1A\u66FF\u6362\u8FDC\u7AEF\u6B64\u73AF\u5883\u7684\u5FEB\u7167\uFF0C\u8BF7\u5148\u6838\u5BF9\u8FDC\u7AEF\u5DEE\u5F02\uFF1B\u5E94\u7528\u4F1A\u5B89\u88C5\u7F3A\u5931\u63D2\u4EF6\u3001\u6062\u590D\u542F\u505C\u5E76\u901A\u8FC7\u5BBF\u4E3B\u5408\u5E76\u666E\u901A\u914D\u7F6E\uFF1B\u4FDD\u7559\u672C\u673A\u51ED\u636E\u4E0E\u8DEF\u5F84\uFF0C\u4E0D\u81EA\u52A8\u53D8\u66F4\u5DF2\u6709\u7248\u672C\u3002"),
            button("\u53D1\u5E03\u672C\u673A\u5FEB\u7167", () => setDialog({ title: "\u53D1\u5E03\u672C\u673A\u73AF\u5883\u5FEB\u7167", body: "\u786E\u8BA4\u5C06\u9884\u68C0\u65F6\u7684\u672C\u673A\u5FEB\u7167\u5199\u5165\u8FDC\u7AEF\u6B64\u73AF\u5883\u76EE\u5F55\uFF1F\u8FDC\u7AEF\u5E76\u53D1\u53D8\u5316\u4F1A\u963B\u6B62\u53D1\u5E03\u3002", detail: `${remote}
${environment} \xB7 ${preview.local.plugins.length} \u4E2A\u63D2\u4EF6 \xB7 ${preview.local.configRows} \u884C\u8131\u654F\u914D\u7F6E`, action: () => run("sync.publish", { token: preview.token, confirm: true }) })),
            preview.hasRemote ? button("\u5E94\u7528\u8FDC\u7AEF\u5FEB\u7167", () => setDialog({ title: "\u5E94\u7528\u8FDC\u7AEF\u73AF\u5883", body: "\u786E\u8BA4\u6267\u884C\u4E0A\u65B9\u5B89\u88C5\u3001\u542F\u505C\u4E0E\u914D\u7F6E\u5408\u5E76\u8BA1\u5212\uFF1F\u51ED\u636E\u3001\u8DEF\u5F84\u7B49\u53D7\u4FDD\u62A4\u5B57\u6BB5\u4FDD\u7559\u672C\u673A\u503C\uFF1B\u4E0D\u652F\u6301\u7684\u914D\u7F6E\u9700\u4EBA\u5DE5\u5904\u7406\u3002", detail: `commit\uFF1A${preview.commit}
` + preview.plan.steps.map((s) => `${PLAN_LABELS[s.action] ?? s.action}\uFF1A${s.name}`).join("\n"), action: () => run("sync.apply", { token: preview.token, confirm: true }) })) : null,
            h("details", null, h("summary", null, "\u6B64\u73AF\u5883\u6700\u8FD1 10 \u6B21\u63D0\u4EA4"), h("pre", { className: "pc-op-log" }, preview.history.join("\n") || "\u6682\u65E0\u5386\u53F2"))
          ) : null,
          busy ? h("p", null, "\u6B63\u5728\u5904\u7406\u2026") : null,
          message ? h("p", { role: "status" }, message) : null,
          error ? h("p", { className: "pc-error", role: "alert" }, error) : null,
          h(ConfirmDialog, { dialog, onClose: setDialog })
        );
      }
      const PLAN_LABELS = {
        install: "\u5C06\u5B89\u88C5",
        enable: "\u5C06\u542F\u7528",
        disable: "\u5C06\u505C\u7528",
        entries: "\u6062\u590D\u6761\u76EE\u5F00\u5173",
        skip: "\u5DF2\u4E00\u81F4",
        blocked: "\u65E0\u6CD5\u5904\u7406"
      };
      function PlanView({ plan }) {
        const counts = {};
        for (const step of plan.steps ?? [])
          counts[step.action] = (counts[step.action] ?? 0) + 1;
        const summary = Object.entries(counts).map(([action, count]) => `${PLAN_LABELS[action] ?? action} ${count}`).join("\uFF5C");
        return h(
          "div",
          { className: "pc-plan", "data-plan": "1" },
          h("p", { className: "pc-summary-inline" }, summary || "\u6CA1\u6709\u9700\u8981\u5904\u7406\u7684\u63D2\u4EF6"),
          (plan.steps ?? []).map(
            (step) => h(
              "p",
              { key: step.name + step.action, className: "pc-note", "data-step": step.action },
              `${step.name}\uFF1A${PLAN_LABELS[step.action] ?? step.action}` + (step.spec ? ` \u2190 ${step.spec}` : "") + (step.reason ? `\uFF08${step.reason}\uFF09` : "") + (step.entries ? `\uFF08${step.entries.length} \u4E2A\u6761\u76EE\uFF09` : "")
            )
          ),
          plan.settings?.changed?.length > 0 ? h(
            "p",
            { className: "pc-note" },
            `\u672C\u63D2\u4EF6\u81EA\u5DF1\u7684\u8BBE\u7F6E\u4F1A\u88AB\u8986\u76D6\uFF1A${plan.settings.changed.join("\u3001")}`
          ) : null,
          plan.builtinRows > 0 ? h("p", { className: "pc-note" }, `\u53E6\u6709 ${plan.builtinRows} \u884C\u5BBF\u4E3B\u5185\u7F6E\u914D\u7F6E\uFF08\u5DF2\u8131\u654F\u4FDD\u7559\uFF0C\u4E0D\u53C2\u4E0E\u7B2C\u4E09\u65B9\u63D2\u4EF6\u81EA\u52A8\u6062\u590D\uFF09`) : null,
          ...(plan.unresolved ?? []).map((row, i) => h("p", { key: "unresolved" + i, className: "pc-field-hint" }, `${row.id || "\u65E0\u6761\u76EE ID"}${row.name ? " \xB7 " + row.name : ""}\uFF1A${row.reason}`)),
          plan.unattributedRows > 0 ? h(
            "p",
            { className: "pc-note" },
            `\u53E6\u6709 ${plan.unattributedRows} \u884C\u8865\u4E01\u5F52\u5C5E\u5C1A\u672A\u786E\u8BA4\uFF08\u5DF2\u8131\u654F\u4FDD\u7559\uFF0C\u4E0D\u81EA\u52A8\u5E94\u7528\u6216\u5220\u9664\uFF09`
          ) : null,
          (plan.warnings ?? []).map(
            (line) => h("p", { key: line, className: "pc-field-hint" }, "\xB7 " + line)
          )
        );
      }
      function InstalledRow({ row, onUpdate, onHotReload, onRemove, onToggle, siteBase }) {
        const verdict = row?.update?.updateAvailable;
        const badge = verdict === true ? h("span", { className: "pc-chip is-warn" }, "\u53EF\u66F4\u65B0") : verdict === false ? h("span", { className: "pc-chip is-ok" }, "\u5DF2\u6700\u65B0") : h("span", { className: "pc-chip" }, "\u672A\u5224\u5B9A");
        const latest = row?.update?.latestVersion ?? (row?.update?.latestCommit ? row.update.latestCommit.slice(0, 7) : row?.detailVersion ?? "\u2014");
        const detail = [
          `\u6765\u6E90 ${row.spec || "\u672A\u77E5"}\uFF08${kindLabel(row.kind)}\uFF09`,
          row.category ? CATEGORY_LABELS[row.category] ?? row.category : "",
          row.detailVersion ? `\u7AD9\u70B9 ${row.detailVersion}` : "",
          row.dshTarget ? `\u76EE\u6807 ${row.dshTarget}` : ""
        ].filter((item) => item !== "").join(" \xB7 ");
        const url = siteUrl(row, siteBase);
        return h(
          "div",
          { className: "pc-row is-tall", "data-plugin": row.name },
          h(
            "div",
            { className: "pc-row-main" },
            h(
              "div",
              { className: "pc-row-title" },
              h("span", { className: "pc-row-name" }, row.displayName || row.name),
              /**
               * 已装页的入口指向**站点详情页**：`slug`/`owner` 由服务端从目录行带过来
               * （`InstalledRow.slug`/`owner`）。拼不出安全地址就只显示文字。
               */
              url === "" ? h("span", { className: "pc-row-repo" }, row.name + (row.repo ? " \xB7 " + row.repo : "")) : h(
                "a",
                {
                  className: "pc-row-repo is-link",
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00 dsh-plugin.org \u8BE6\u60C5\u9875\uFF1A" + url,
                  "data-open-site": row.repo
                },
                row.name + " \xB7 " + row.repo
              ),
              badge,
              row.selected ? null : h("span", { className: "pc-chip is-muted" }, "\u672A\u542F\u7528")
            ),
            h("p", { className: "pc-row-desc", title: detail }, detail),
            row?.update?.error ? h("p", { className: "pc-row-warn" }, row.update.error) : row?.update?.note ? h("p", { className: "pc-row-note" }, row.update.note) : row?.installCommand ? h("p", { className: "pc-row-note" }, row.installCommand) : null
          ),
          h(
            "div",
            { className: "pc-row-meta" },
            h("span", null, "\u5F53\u524D " + (row.version ?? "\u2014")),
            h("span", null, "\u6700\u65B0 " + latest),
            typeof row.stars === "number" ? h("span", null, "\u2605 " + formatStars(row.stars)) : null,
            // 本地路径插件由用户更新源码并构建，通过热重载加载；不提供远端更新。
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small",
                disabled: row.kind === "path" || verdict === false,
                title: row.kind === "path" ? "\u672C\u5730\u8DEF\u5F84\u63D2\u4EF6\u8BF7\u5728\u6E90\u7801\u76EE\u5F55\u66F4\u65B0\u5E76\u6784\u5EFA\uFF1B\u5DF2\u542F\u7528\u65F6\u53EF\u4F7F\u7528\u70ED\u91CD\u8F7D" : verdict === false ? "\u5DF2\u662F\u6700\u65B0\u7248\u672C" : void 0,
                onClick: () => {
                  if (row.kind !== "path" && verdict !== false) onUpdate?.(row);
                }
              },
              "\u66F4\u65B0"
            ),
            /**
             * 热重载只对**已启用**的插件开放：它是「按磁盘上当前的代码重新组合」，
             * 不改启用状态（重建过 dist/ 的已链接包靠它生效，不用重启 DSH）。
             */
            row.selected ? h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small",
                onClick: () => onHotReload?.(row)
              },
              "\u70ED\u91CD\u8F7D"
            ) : null,
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small",
                onClick: () => onToggle?.(row)
              },
              row.selected ? "\u505C\u7528" : "\u542F\u7528"
            ),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-small is-danger",
                onClick: () => onRemove?.(row)
              },
              "\u5378\u8F7D"
            )
          )
        );
      }
      function Settings({ call, settings, status, error, onSaved }) {
        const [form, setForm] = useState({
          locale: settings?.locale ?? "zh",
          hours: settings ? String(Math.round((settings.syncTtlMs ?? 0) / 36e5)) : "24",
          siteBase: settings?.siteBase ?? "",
          apiBase: settings?.apiBase ?? "",
          registry: settings?.registry ?? "",
          proxy: settings?.proxy ?? ""
        });
        const [state, setState] = useState({
          busy: false,
          error: "",
          ok: "",
          checks: null,
          diagBusy: false,
          diagError: ""
        });
        const [catalog, setCatalog] = useState(null);
        useEffect(() => {
          let cancelled = false;
          (async () => {
            try {
              const value = await call("catalog.status");
              if (!cancelled) setCatalog(value);
            } catch {
            }
          })();
          return () => {
            cancelled = true;
          };
        }, [call]);
        const set = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
        const save = async () => {
          const hours = Number(form.hours);
          if (!Number.isFinite(hours) || hours <= 0) {
            setState((previous) => ({
              ...previous,
              ok: "",
              error: "\u540C\u6B65\u95F4\u9694\u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u5C0F\u65F6\u6570"
            }));
            return;
          }
          setState((previous) => ({ ...previous, busy: true, error: "", ok: "" }));
          try {
            const next = await call("settings.set", {
              locale: form.locale,
              syncTtlMs: Math.round(hours * 36e5),
              siteBase: form.siteBase,
              apiBase: form.apiBase,
              registry: form.registry,
              proxy: form.proxy
            });
            onSaved?.(next);
            setState((previous) => ({ ...previous, busy: false, ok: "\u5DF2\u4FDD\u5B58" }));
          } catch (cause) {
            setState((previous) => ({
              ...previous,
              busy: false,
              error: String(cause?.message ?? cause)
            }));
          }
        };
        const runDiagnostics = async () => {
          setState((previous) => ({ ...previous, diagBusy: true, diagError: "" }));
          try {
            const checks2 = await call("diagnostics.run");
            setState((previous) => ({
              ...previous,
              diagBusy: false,
              checks: Array.isArray(checks2) ? checks2 : []
            }));
          } catch (cause) {
            setState((previous) => ({
              ...previous,
              diagBusy: false,
              diagError: String(cause?.message ?? cause)
            }));
          }
        };
        const field = (label, key, extra = {}) => h(
          "label",
          { className: "pc-field", key },
          h("span", { className: "pc-field-label" }, label),
          extra.options ? h(
            "select",
            {
              className: "pc-select pc-input",
              value: form[key],
              "aria-label": label,
              onChange: (event) => set(key, event?.target?.value ?? "")
            },
            extra.options.map(
              (option) => h("option", { key: option.value, value: option.value }, option.label)
            )
          ) : h("input", {
            className: "pc-input",
            type: extra.type ?? "text",
            ...extra.inputMode ? { inputMode: extra.inputMode } : {},
            value: form[key],
            "aria-label": label,
            placeholder: extra.placeholder ?? "",
            onChange: (event) => set(key, event?.target?.value ?? "")
          }),
          extra.hint ? h("span", { className: "pc-field-hint" }, extra.hint) : null
        );
        const checks = state.checks;
        const summary = Array.isArray(checks) ? checks.reduce(
          (acc, entry) => {
            if (entry.ok === true) acc.ok += 1;
            else if (entry.ok === false) acc.fail += 1;
            else acc.unknown += 1;
            return acc;
          },
          { ok: 0, fail: 0, unknown: 0 }
        ) : null;
        return h(
          "div",
          { className: "pc-market" },
          error || state.error ? h("p", { className: "pc-error" }, error || state.error) : null,
          h(
            "section",
            { className: "pc-card" },
            cardHead("\u76EE\u5F55\u4E0E\u6765\u6E90", "\u51B3\u5B9A\u6293\u54EA\u4E00\u5957\u76EE\u5F55\u3001\u591A\u4E45\u5237\u65B0\u4E00\u6B21"),
            h(
              "div",
              { className: "pc-form" },
              field("\u754C\u9762\u4E0E\u76EE\u5F55\u8BED\u8A00", "locale", {
                options: [
                  { value: "zh", label: "\u7B80\u4F53\u4E2D\u6587\uFF08zh\uFF09" },
                  { value: "en", label: "English\uFF08en\uFF09" }
                ],
                hint: "\u51B3\u5B9A\u6293 /zh \u8FD8\u662F /en \u7684\u5206\u7247\uFF1B\u754C\u9762\u6587\u6848\u6682\u4E0D\u968F\u6B64\u5207\u6362"
              }),
              field("\u81EA\u52A8\u5237\u65B0\u95F4\u9694\uFF08\u5C0F\u65F6\uFF09", "hours", {
                placeholder: "24",
                inputMode: "decimal",
                hint: "15 \u5206\u949F \u2013 30 \u5929\u3002\u65E0\u53D8\u66F4\u5237\u65B0\u53EA\u82B1 253KB"
              }),
              field("\u5B98\u7F51\u57FA\u5740", "siteBase", {
                placeholder: "https://dsh-plugin.org",
                hint: "\u76EE\u5F55\u5206\u7247\u4E0E\u63D2\u4EF6\u8BE6\u60C5\u9875"
              }),
              field("API \u4E2D\u5FC3\u57FA\u5740", "apiBase", {
                placeholder: "https://api.dsh-plugin.org",
                hint: "curated \u589E\u5F3A\u4E0E\u6536\u5F55\u7EDF\u8BA1"
              })
            ),
            Array.isArray(settings?.notes) && settings.notes.length > 0 ? h(
              "p",
              { className: "pc-note-block" },
              "\u8BFB\u53D6\u8BBE\u7F6E\u65F6\u6709\u5B57\u6BB5\u88AB\u9000\u56DE\u9ED8\u8BA4\u503C\uFF1A" + settings.notes.join("\uFF1B")
            ) : null
          ),
          h(
            "section",
            { className: "pc-card" },
            cardHead("\u7F51\u7EDC\u4E0E\u955C\u50CF", "\u7559\u7A7A\u8868\u793A\u7528\u5B98\u65B9\u6E90\u4E0E\u5BBF\u4E3B\u4EE3\u7406"),
            h(
              "div",
              { className: "pc-form" },
              field("npm registry\uFF08\u7559\u7A7A\u7528\u5B98\u65B9\u6E90\uFF09", "registry", {
                placeholder: "https://registry.npmjs.org",
                hint: "\u66F4\u65B0\u5224\u636E\u4E0E\u5B89\u88C5\u90FD\u8D70\u5B83\uFF1B\u53EF\u586B\u56FD\u5185\u955C\u50CF"
              }),
              field("\u51FA\u7F51\u4EE3\u7406\uFF08\u7559\u7A7A\u4EA4\u7ED9\u5BBF\u4E3B\uFF09", "proxy", {
                placeholder: "http://127.0.0.1:7890",
                hint: "\u76EE\u5F55\u3001registry\u3001git \u53D6\u6570\u7EDF\u4E00\u8D70\u5B83"
              })
            )
          ),
          h(
            "footer",
            { className: "pc-form-footer" },
            h(
              "span",
              { className: "pc-field-hint" },
              status?.dataDir ? "\u4FDD\u5B58\u5728 " + status.dataDir + "/settings.json" : "\u4FDD\u5B58\u5728\u672C\u63D2\u4EF6\u6570\u636E\u76EE\u5F55"
            ),
            state.ok ? h("span", { className: "pc-ok-inline" }, state.ok) : null,
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-primary",
                disabled: state.busy,
                onClick: save
              },
              state.busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u8BBE\u7F6E"
            )
          ),
          h(
            "section",
            { className: "pc-card" },
            cardHead("\u5B58\u50A8\u4E0E\u8FD0\u884C", "\u672C\u5730\u7D22\u5F15\u7684\u73B0\u72B6\uFF08\u53EA\u8BFB\uFF09"),
            h(
              "dl",
              { className: "pc-kv" },
              kv("profile", status?.profile),
              kv("\u6570\u636E\u76EE\u5F55", status?.dataDir),
              kv("\u76EE\u5F55\u5E93", status?.dbPath),
              kv("SQLite", status?.store?.sqlite),
              kv(
                "\u76EE\u5F55\u6761\u76EE",
                catalog ? `${catalog.rows.toLocaleString("zh-CN")} \u6761` + (catalog.totalCount === null ? "" : `\uFF08\u7AD9\u70B9\u81EA\u62A5 ${catalog.totalCount.toLocaleString("zh-CN")}\uFF09`) : "\u2014"
              ),
              kv("\u4E0A\u6B21\u540C\u6B65", catalog?.lastSyncAt ? formatTime(catalog.lastSyncAt) : "\u5C1A\u672A\u540C\u6B65"),
              kv("\u4E0A\u6B21\u540C\u6B65\u9519\u8BEF", catalog?.error ?? "\u65E0"),
              /**
               * 热重载能力：决定装完/改完要不要重启。来自宿主上下文里的 `hmr` 服务探测，
               * 不需要跑诊断就能看见（诊断里另有一项同样口径的检查）。
               */
              kv(
                "\u70ED\u91CD\u8F7D",
                status?.hot === true ? "\u5BBF\u4E3B\u5DF2\u542F\u7528\uFF08\u53D8\u66F4\u539F\u5730\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\uFF09" : status?.hot === false ? "\u5BBF\u4E3B\u672A\u542F\u7528\uFF08\u53D8\u66F4\u9700\u8981\u91CD\u542F DSH\uFF09" : "\u672A\u77E5"
              )
            )
          ),
          h(
            "section",
            { className: "pc-card" },
            cardHead("\u8BCA\u65AD", "\u53EA\u8BFB\u8FDE\u901A\u6027\u68C0\u67E5\uFF0C\u5E73\u65F6\u4E0D\u4F1A\u81EA\u52A8\u51FA\u7F51"),
            h(
              "div",
              { className: "pc-form-footer is-inline" },
              summary ? h(
                "span",
                { className: "pc-summary-inline" },
                `\u901A\u8FC7 ${summary.ok}\uFF5C\u5931\u8D25 ${summary.fail}\uFF5C\u65E0\u7ED3\u8BBA ${summary.unknown}`
              ) : h("span", { className: "pc-field-hint" }, "\u8FD8\u6CA1\u6709\u68C0\u67E5\u8FC7"),
              h(
                "button",
                {
                  type: "button",
                  className: "pc-btn",
                  disabled: state.diagBusy,
                  onClick: runDiagnostics
                },
                state.diagBusy ? "\u68C0\u67E5\u4E2D\u2026" : "\u8FD0\u884C\u8BCA\u65AD"
              )
            ),
            state.diagError ? h("p", { className: "pc-error" }, state.diagError) : null,
            Array.isArray(checks) ? h("div", { className: "pc-diag" }, checks.map(renderCheck)) : null
          )
        );
      }
      function Panel(props) {
        const ctx = props?.ctx;
        const call = useCallback(
          (method, payload = {}) => ctx.connection.rpc.call("/api", "plugin-harbor", { version: 1, method, payload }).then((result) => {
            if (result?.ok === false) {
              const message = String(result.error?.message ?? "\u8BF7\u6C42\u5931\u8D25");
              throw Error(message);
            }
            return result.value ?? result;
          }),
          [ctx]
        );
        const [status, setStatus] = useState(null);
        const [error, setError] = useState("");
        const [tab, setTab] = useState("market");
        const [installed, setInstalled] = useState(null);
        const [installedError, setInstalledError] = useState("");
        const [ops, setOps] = useState(null);
        const [opsError, setOpsError] = useState("");
        const [dialog, setDialog] = useState(null);
        const [settings, setSettings] = useState(null);
        const [settingsError, setSettingsError] = useState("");
        const lastLive = useRef(-1);
        useEffect(() => {
          let cancelled = false;
          let pending = false;
          const refresh = async () => {
            if (pending) return;
            pending = true;
            try {
              const value = await call("status");
              if (!cancelled) {
                setStatus(value);
                setError("");
              }
            } catch (cause) {
              if (!cancelled) setError(String(cause?.message ?? cause));
            } finally {
              pending = false;
            }
          };
          void refresh();
          return () => {
            cancelled = true;
          };
        }, [call]);
        const loadInstalled = useCallback(async () => {
          try {
            const rows = await call("installed.list");
            setInstalled(Array.isArray(rows) ? rows : []);
            setInstalledError("");
          } catch (cause) {
            setInstalledError(String(cause?.message ?? cause));
          }
        }, [call]);
        useEffect(() => {
          loadInstalled();
        }, [loadInstalled]);
        const loadSettings = useCallback(async () => {
          try {
            const value = await call("settings.get");
            setSettings(value);
            setSettingsError("");
          } catch (cause) {
            setSettingsError(String(cause?.message ?? cause));
          }
        }, [call]);
        useEffect(() => {
          loadSettings();
        }, [loadSettings]);
        const installedRepos = new Set(
          (Array.isArray(installed) ? installed : []).map((row) => row?.repo).filter((repo) => typeof repo === "string")
        );
        const loadOps = useCallback(async () => {
          try {
            const value = await call("op.list");
            setOps(value);
            setOpsError("");
            return value;
          } catch (cause) {
            setOpsError(String(cause?.message ?? cause));
            return void 0;
          }
        }, [call]);
        useEffect(() => {
          loadOps();
        }, [loadOps]);
        const liveCount = Array.isArray(ops?.tasks) ? ops.tasks.filter(
          (task) => task.status === "queued" || task.status === "running"
        ).length : 0;
        useEffect(() => {
          if (liveCount === 0) return void 0;
          const timer = setInterval(() => {
            loadOps();
          }, 1e3);
          return () => clearInterval(timer);
        }, [liveCount, loadOps]);
        useEffect(() => {
          if (lastLive.current > 0 && liveCount === 0) loadInstalled();
          lastLive.current = liveCount;
        }, [liveCount, loadInstalled]);
        const runOp = useCallback(
          async (method, payload) => {
            setOpsError("");
            try {
              await call(method, { ...payload, confirm: true });
              await loadOps();
            } catch (cause) {
              setOpsError(String(cause?.message ?? cause));
            }
          },
          [call, loadOps]
        );
        const askInstall = useCallback(
          (row) => {
            const spec = row?.npmPackage ? row.npmPackage : row?.repo ? `github:${row.repo}` : "";
            setDialog({
              title: "\u5B89\u88C5\u63D2\u4EF6",
              body: row?.displayName || row?.name || row?.repo || "",
              detail: spec === "" ? "\u7AD9\u70B9\u6CA1\u6709\u7ED9\u51FA\u53EF\u7528\u7684\u5B89\u88C5\u5730\u5740" : `dsh plugin add ${spec}\uFF1B${effectText(status)}`,
              confirmLabel: "\u5B89\u88C5",
              action: spec === "" ? void 0 : () => runOp("op.install", { spec })
            });
          },
          [runOp, status]
        );
        const askUpdate = useCallback(
          (row) => {
            setDialog({
              title: "\u66F4\u65B0\u63D2\u4EF6",
              body: `${row?.name}\uFF1A${row?.version ?? "\u672A\u77E5\u7248\u672C"} \u2192 ${row?.update?.latestVersion ?? (row?.update?.latestCommit ?? "\u6700\u65B0").slice?.(0, 7) ?? "\u6700\u65B0"}`,
              detail: row?.kind === "registry" ? `\u5BBF\u4E3B\u4F1A\u5148\u5378\u8F7D\u65E7\u7248\u672C\u518D\u5B89\u88C5\u65B0\u7248\u672C\uFF1B${effectText(status)}` : `\u6309\u539F\u5730\u5740\u91CD\u88C5\uFF08${row?.spec ?? "\u672A\u77E5\u6765\u6E90"}\uFF09\uFF1B${effectText(status)}`,
              confirmLabel: "\u66F4\u65B0",
              action: () => runOp("op.update", { name: row?.name })
            });
          },
          [runOp, status]
        );
        const askHotReload = useCallback(
          (row) => {
            setDialog({
              title: "\u70ED\u91CD\u8F7D\u63D2\u4EF6",
              body: `${row?.name}`,
              detail: `\u6309\u78C1\u76D8\u4E0A\u5F53\u524D\u7684\u4EE3\u7801\u91CD\u65B0\u7EC4\u5408\u5E76\u52A0\u8F7D\uFF1B${effectText(status)}`,
              confirmLabel: "\u70ED\u91CD\u8F7D",
              action: () => runOp("op.reload", { name: row?.name })
            });
          },
          [runOp, status]
        );
        const askRemove = useCallback(
          (row) => {
            setDialog({
              title: "\u5378\u8F7D\u63D2\u4EF6",
              body: `${row?.name}`,
              detail: `\u4F1A\u4ECE\u5F53\u524D profile \u7684\u4F9D\u8D56\u91CC\u79FB\u9664\u8BE5\u63D2\u4EF6\uFF0C\u5E76\u505C\u7528\u5B83\u7684 bundle\uFF1B${effectText(status)}`,
              confirmLabel: "\u5378\u8F7D",
              action: () => runOp("op.remove", { name: row?.name })
            });
          },
          [runOp, status]
        );
        const askToggle = useCallback(
          (row) => {
            const enabled = !row?.selected;
            setDialog({
              title: enabled ? "\u542F\u7528\u63D2\u4EF6" : "\u505C\u7528\u63D2\u4EF6",
              body: `${row?.name}`,
              detail: enabled ? `\u628A\u5B83\u52A0\u5165\u5F53\u524D profile \u7684 bundle \u5217\u8868\uFF1B${effectText(status)}` : `\u4FDD\u7559\u4F9D\u8D56\uFF0C\u4F46\u4ECE bundle \u5217\u8868\u91CC\u79FB\u9664\uFF08\u4E0D\u5378\u8F7D\uFF09\uFF1B${effectText(status)}`,
              confirmLabel: enabled ? "\u542F\u7528" : "\u505C\u7528",
              action: () => runOp("op.setEnabled", { name: row?.name, enabled })
            });
          },
          [runOp, status]
        );
        return h(
          "div",
          { className: "pc" },
          h("style", null, client_default),
          h(
            "header",
            { className: "pc-head" },
            h(
              "div",
              { className: "pc-title" },
              h("h2", null, LABEL),
              status?.version ? h("span", { className: "pc-ver" }, "v" + status.version) : null
            ),
            h(
              "div",
              { className: "pc-actions" },
              status?.dbPath ? h("span", { className: "pc-ver", title: status.dbPath }, "\u76EE\u5F55\u5E93 " + status.store?.sqlite) : null
            )
          ),
          h(
            "nav",
            { className: "pc-tabs" },
            TABS.map(
              (item) => h(
                "button",
                {
                  key: item.id,
                  type: "button",
                  className: "pc-tab" + (item.id === tab ? " is-on" : ""),
                  "aria-pressed": item.id === tab,
                  onClick: () => setTab(item.id)
                },
                item.label
              )
            )
          ),
          h(
            "div",
            { className: "pc-body" },
            error ? h("p", { className: "pc-error" }, error) : null,
            tab === "market" ? h(Market, {
              call,
              installedRepos,
              onInstall: askInstall,
              // 详情页地址按本 profile 的站点基址拼（设置页可改，默认 dsh-plugin.org）
              siteBase: settings?.siteBase
            }) : null,
            tab === "installed" ? h(Installed, {
              call,
              installed,
              error: installedError,
              onReload: loadInstalled,
              onUpdate: askUpdate,
              onHotReload: askHotReload,
              onRemove: askRemove,
              onToggle: askToggle,
              siteBase: settings?.siteBase
            }) : null,
            tab === "ops" ? h(Ops, { ops, error: opsError, onCancel: (id) => runOp("op.cancel", { id }), busy: false }) : null,
            tab === "settings" ? h(Settings, {
              call,
              settings,
              status,
              error: settingsError,
              onSaved: (next) => setSettings(next)
            }) : null
          ),
          h(ConfirmDialog, { dialog, onClose: setDialog })
        );
      }
      return {
        name: "plugin-harbor",
        id: "dsh-plugin-harbor",
        inject: ["slots", "connection"],
        apply(ctx) {
          ctx.slots.inject(
            "sidebar.panellist",
            () => ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 36,
                label: () => LABEL,
                /**
                 * 构建标识随注册一起交出去：宿主会忽略这个多余字段，但它让测试与诊断能直接
                 * 读到「这份面板是哪次构建」，从而构造/验证「宿主是旧构建」的错配场景。
                 */
                build: BUILD
              },
              CenterIcon
            )
          );
          ctx.slots.inject(
            "main",
            () => ctx.slots.register(
              { name: "main", key: PANEL_ID },
              (props) => h(Panel, { ...props, ctx })
            )
          );
        }
      };
    }
  });
})();
