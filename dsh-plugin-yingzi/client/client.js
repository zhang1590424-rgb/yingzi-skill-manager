/**
 * Client half of the Yingzi (影子) panel bundle.
 *
 * Registers:
 *   - a sidebar panel icon (slot `sidebar.panellist`, id `yingzi`, order 20 —
 *     below 插件 at order 0 and 定时任务 at order 10);
 *   - the main panel it opens (keyed slot `main`, key `yingzi`).
 *
 * The panel ports the 影子 workbench design (see 影子 DESIGN.md):
 * toolbar with a custom target dropdown, tag filter chips with the 16-color
 * palette, cards grouped by tag (library view) or by status (target view),
 * a 340px right detail drawer, a sticky batch bar, confirm modals for
 * overwrite and batch operations, top toasts plus inline error bars.
 *
 * Colors: structure uses `--dsw-alias-*` theme tokens so light/dark follow
 * the host; semantic pastels are built from state tokens with color-mix;
 * the tag palette is literal data color from 影子. Only transform/opacity
 * animate; `prefers-reduced-motion` is honored. No Harness client package
 * is imported as a module.
 */
window.__ModuleLoader__.load({
  id: "@local/yingzi-panel",
  factory(require) {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const NS = "yingzi";
    const PANEL_ID = "yingzi";
    const API_PATH = "/yingzi/api";
    const TOKEN_KEY = "__YINGZI_TOKEN__";

    /* ---------------------------------------------------------------- */
    /* 影子 tag palette (literal data colors, from 影子 App.tsx)           */
    /* ---------------------------------------------------------------- */

    const TAG_PALETTE = [
      { bg: "#DBEAFE", text: "#1E40AF" },
      { bg: "#D1FAE5", text: "#065F46" },
      { bg: "#FEF3C7", text: "#92400E" },
      { bg: "#FEE2E2", text: "#991B1B" },
      { bg: "#F3E8FF", text: "#6B21A8" },
      { bg: "#CFFAFE", text: "#155E75" },
      { bg: "#FFEDD5", text: "#9A3412" },
      { bg: "#FCE7F3", text: "#9D174D" },
      { bg: "#E0E7FF", text: "#3730A3" },
      { bg: "#ECFCCB", text: "#3F6212" },
      { bg: "#FEF9C3", text: "#854D0E" },
      { bg: "#CCFBF1", text: "#115E59" },
      { bg: "#F5F3FF", text: "#5B21B6" },
      { bg: "#FFF1F2", text: "#9F1239" },
      { bg: "#F3F4F6", text: "#374151" },
      { bg: "#E5E7EB", text: "#1F2937" },
    ];

    /* ---------------------------------------------------------------- */
    /* locale dictionaries (keys relative to the namespace)               */
    /* ---------------------------------------------------------------- */

    const ZH = {
      panel: "影子",
      loading: "正在读取技能库…",
      "target.all": "全部技能",
      "target.label": "目标",
      "target.default": "默认",
      "status.all": "全部状态",
      "status.applied": "已应用",
      "status.notApplied": "未应用",
      "status.problem": "有问题",
      "search.placeholder": "搜索名称 / 描述…",
      "action.refresh": "刷新",
      "action.import": "导入技能",
      "action.importHint": "导入本地技能目录（含 SKILL.md）",
      "action.apply": "应用",
      "action.withdraw": "收回",
      "action.overwrite": "覆盖应用",
      "action.reveal": "打开目录",
      "action.close": "关闭",
      "action.dismiss": "知道了",
      "action.retry": "重试",
      "action.cancel": "取消",
      "settings.title": "设置",
      "settings.section.root": "技能根目录",
      "settings.section.targets": "目标目录",
      "settings.section.tags": "标签管理",
      "settings.libraryName": "主库",
      "settings.addTarget": "添加目标",
      "settings.newTag": "新建标签",
      "settings.newTagPlaceholder": "输入标签名称，回车确认",
      "settings.tagCount": "{n} 个技能",
      "settings.emptyTags": "还没有标签。导入技能或编辑 SKILL.md 的 tags 后自动创建。",
      "settings.confirm": "确认",
      "settings.open": "打开",
      "settings.remove": "移除",
      "settings.removeTargetTitle": "移除目标确认",
      "settings.removeTargetHint": "将把该目标从配置中移除；若目录内仍有受管影子，移除会被拒绝。",
      "settings.syncHint": "写入的配置需在影子.app 内刷新一次后才可见。",
      "tags.all": "全部",
      "tags.none": "无标签",
      "group.untagged": "无标签",
      "statusRaw.enabled": "已应用",
      "statusRaw.disabled": "未应用",
      "statusRaw.broken": "已失效",
      "statusRaw.conflict": "冲突",
      "statusRaw.pathMissing": "目标缺失",
      "statusRaw.unreadable": "无法读取",
      "statusRaw.invalid": "格式异常",
      "issue.pathMissingRoot": "目标技能目录不存在",
      "issue.symlinkForeign": "目标位置已有指向别处的软链接",
      "issue.brokenLink": "软链接目标不存在",
      "issue.contentExists": "目标位置已有同名内容",
      "issue.unreadable": "无法读取目标位置",
      "issue.linkTarget": "链接目标",
      "drawer.statusByTarget": "各目标状态",
      "drawer.libraryPath": "主库路径",
      "drawer.preview": "SKILL.md 预览",
      "drawer.noPreview": "（无预览内容）",
      "drawer.emptyDesc": "（SKILL.md 未提供描述）",
      "batch.scope": "当前筛选 {count} 项 · 将应用到 {target}",
      "batch.applyAll": "全部应用",
      "batch.withdrawAll": "全部收回",
      "confirm.overwriteTitle": "覆盖确认",
      "confirm.overwriteHint": "以下目标位置已有内容，覆盖将先移除同名内容再建立指向主库的影子：",
      "confirm.batchApplyTitle": "批量应用确认",
      "confirm.batchWithdrawTitle": "批量收回确认",
      "confirm.batchHint": "将对目标 {target} 下的 {count} 个技能执行「{action}」；只作用于当前筛选结果。",
      "confirm.batchApply": "批量应用",
      "confirm.batchWithdraw": "批量收回",
      "report.title": "操作报告",
      "toast.applied": "应用完成",
      "toast.withdrawn": "收回完成",
      "toast.imported": "导入成功：{id}",
      "toast.partial": "部分完成：新增 {changed}，跳过 {skipped}",
      "empty.library": "技能主库为空",
      "empty.libraryHint": "把含 SKILL.md 的目录导入主库后，即可在这里查看与分发影子。",
      "empty.filter": "没有符合筛选条件的技能",
      "empty.targetRoot": "目标技能目录不存在，应用时会自动创建。",
      "error.noToken": "未获取到访问令牌，请刷新页面后重试（插件刚安装时页面需要重新加载一次）。",
      "error.loading": "读取失败",
      "error.import": "导入失败",
    };

    const EN = {
      panel: "Yingzi",
      loading: "Loading skill library…",
      "target.all": "All skills",
      "target.label": "Target",
      "target.default": "Default",
      "status.all": "All statuses",
      "status.applied": "Applied",
      "status.notApplied": "Not applied",
      "status.problem": "Problem",
      "search.placeholder": "Search name / description…",
      "action.refresh": "Refresh",
      "action.import": "Import skill",
      "action.importHint": "Import a local skill directory (with SKILL.md)",
      "action.apply": "Apply",
      "action.withdraw": "Withdraw",
      "action.overwrite": "Overwrite",
      "action.reveal": "Reveal folder",
      "action.close": "Close",
      "action.dismiss": "Dismiss",
      "action.retry": "Retry",
      "action.cancel": "Cancel",
      "settings.title": "Settings",
      "settings.section.root": "Skill library root",
      "settings.section.targets": "Target directories",
      "settings.section.tags": "Tag management",
      "settings.libraryName": "Library",
      "settings.addTarget": "Add target",
      "settings.newTag": "New tag",
      "settings.newTagPlaceholder": "Type a tag name, press Enter to confirm",
      "settings.tagCount": "{n} skills",
      "settings.emptyTags": "No tags yet. Import skills or edit tags in SKILL.md to create them.",
      "settings.confirm": "Confirm",
      "settings.open": "Open",
      "settings.remove": "Remove",
      "settings.removeTargetTitle": "Remove target confirmation",
      "settings.removeTargetHint": "This removes the target from the configuration; removal is rejected if managed shadows remain inside.",
      "settings.syncHint": "Changes become visible in 影子.app after it refreshes once.",
      "tags.all": "All",
      "tags.none": "Untagged",
      "group.untagged": "Untagged",
      "statusRaw.enabled": "Applied",
      "statusRaw.disabled": "Not applied",
      "statusRaw.broken": "Broken",
      "statusRaw.conflict": "Conflict",
      "statusRaw.pathMissing": "Target missing",
      "statusRaw.unreadable": "Unreadable",
      "statusRaw.invalid": "Invalid",
      "issue.pathMissingRoot": "Target skill directory does not exist",
      "issue.symlinkForeign": "A symlink pointing elsewhere already exists",
      "issue.brokenLink": "Symlink target does not exist",
      "issue.contentExists": "Content with the same name already exists",
      "issue.unreadable": "Target path is unreadable",
      "issue.linkTarget": "Link target",
      "drawer.statusByTarget": "Status per target",
      "drawer.libraryPath": "Library path",
      "drawer.preview": "SKILL.md preview",
      "drawer.noPreview": "(no preview)",
      "drawer.emptyDesc": "(SKILL.md has no description)",
      "batch.scope": "{count} filtered · will apply to {target}",
      "batch.applyAll": "Apply all",
      "batch.withdrawAll": "Withdraw all",
      "confirm.overwriteTitle": "Overwrite confirmation",
      "confirm.overwriteHint": "These target locations already hold content; overwriting removes it and re-links to the library:",
      "confirm.batchApplyTitle": "Batch apply confirmation",
      "confirm.batchWithdrawTitle": "Batch withdraw confirmation",
      "confirm.batchHint": "This will {action} {count} skills on target {target}; only the current filter results are affected.",
      "confirm.batchApply": "Apply all",
      "confirm.batchWithdraw": "Withdraw all",
      "report.title": "Operation report",
      "toast.applied": "Apply finished",
      "toast.withdrawn": "Withdraw finished",
      "toast.imported": "Imported: {id}",
      "toast.partial": "Partially done: {changed} changed, {skipped} skipped",
      "empty.library": "The skill library is empty",
      "empty.libraryHint": "Import a directory containing SKILL.md to view and distribute shadows here.",
      "empty.filter": "No skills match the current filters",
      "empty.targetRoot": "The target skill directory does not exist; it will be created on apply.",
      "error.noToken": "No access token found; reload the page and retry (the page must reload once after the plugin is first installed).",
      "error.loading": "Failed to load",
      "error.import": "Import failed",
    };

    /* ---------------------------------------------------------------- */
    /* data layer                                                         */
    /* ---------------------------------------------------------------- */

    async function api(op, args) {
      const token = globalThis[TOKEN_KEY];
      const res = await fetch(API_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-yingzi-token": token } : {}),
        },
        body: JSON.stringify({ op, ...args }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (data && data.error) throw new Error(data.error);
      return data;
    }

    /** 后端 7 种诊断状态 → 3 种展示状态（与影子前端映射一致）。 */
    const PILL_OF = { enabled: "applied", disabled: "notApplied" };
    function pillOf(raw) {
      return PILL_OF[raw] ?? "problem";
    }

    function fmt(template, params) {
      let out = String(template ?? "");
      for (const [key, value] of Object.entries(params ?? {})) {
        out = out.split(`{${key}}`).join(String(value));
      }
      return out;
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function tagColorOf(tag, tagMeta) {
      const stored = (tagMeta ?? []).find((meta) => meta.name === tag);
      if (stored !== undefined && stored.colorIndex >= 0) return TAG_PALETTE[stored.colorIndex % 16];
      let hash = 0;
      for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
      return TAG_PALETTE[hash % 16];
    }

    /* ---------------------------------------------------------------- */
    /* styles — 影子 workbench port; structure on --dsw-alias-* tokens     */
    /* ---------------------------------------------------------------- */

    const CSS = `
.yng-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",sans-serif;background:var(--dsw-alias-bg-base);}
.yng-root button{font-family:inherit;}
.yng-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}

/* ===== toolbar ===== */
.yng-toolbar{flex:none;display:flex;flex-direction:column;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.yng-toolbar-row{display:flex;gap:8px;align-items:center;}
.yng-search{flex:1;min-width:120px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);outline:none;transition:border-color 200ms ease;}
.yng-search::placeholder{color:var(--dsw-alias-label-secondary);opacity:0.7;}
.yng-search:focus{border-color:var(--dsw-alias-border-l2);}
.yng-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:border-color 200ms ease,color 200ms ease,transform 200ms ease;}
.yng-iconbtn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.yng-iconbtn:active{transform:scale(0.96);}
.yng-iconbtn:disabled{opacity:0.55;cursor:default;transform:none;}
.yng-iconbtn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
.yng-spin{animation:yngSpin 900ms linear infinite;}
@keyframes yngSpin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}

/* ===== target dropdown ===== */
.yng-dd{position:relative;flex:none;}
.yng-dd-trigger{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;transition:border-color 200ms ease;}
.yng-dd-trigger:hover{border-color:var(--dsw-alias-border-l2);}
.yng-dd-label{font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;}
.yng-dd-chevron{color:var(--dsw-alias-label-secondary);transform:rotate(-90deg);transition:transform 200ms ease;display:inline-flex;}
.yng-dd.open .yng-dd-chevron{transform:rotate(0deg);}
.yng-dd-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:240px;max-width:380px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:4px;z-index:50;animation:yngScaleIn 200ms cubic-bezier(0.16,1,0.3,1) both;}
@keyframes yngScaleIn{from{opacity:0;transform:scale(0.96);}to{opacity:1;transform:scale(1);}}
.yng-dd-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:4px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background 200ms ease;}
.yng-dd-item:hover{background:var(--dsw-alias-bg-layer-2);}
.yng-dd-item.active{background:var(--dsw-alias-bg-layer-2);font-weight:500;}
.yng-dd-name{white-space:nowrap;display:inline-flex;align-items:center;}
.yng-dd-path{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ===== filter chips ===== */
.yng-filterrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.yng-chip{padding:5px 12px;border-radius:9999px;font-size:11px;font-weight:500;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:none;cursor:pointer;display:inline-flex;align-items:center;transition:background 200ms ease,color 200ms ease;}
.yng-chip:hover{color:var(--dsw-alias-label-primary);}
.yng-chip.active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.yng-chip-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;}
.yng-chip.notag{border:1px dashed var(--dsw-alias-border-l1);background:transparent;}
.yng-chip.notag:hover{background:var(--dsw-alias-bg-layer-2);}
.yng-chip.notag.active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-brand-primary);}
.yng-statusdd{position:relative;margin-left:auto;}

/* ===== banners ===== */
.yng-banner{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 20px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.yng-banner.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);}
.yng-banner.error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);}
.yng-banner-close{border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;font-family:inherit;text-decoration:underline;text-underline-offset:2px;padding:0;}

/* ===== main scroll area & groups ===== */
.yng-main{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;}
.yng-group{margin-bottom:24px;}
.yng-group:last-child{margin-bottom:0;}
.yng-group-header{display:flex;align-items:center;gap:8px;margin-bottom:12px;}
.yng-group-dot{width:7px;height:7px;border-radius:50%;flex:none;}
.yng-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}
.yng-group-count{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);}
.yng-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-content:start;}
@media (max-width:760px){.yng-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}

/* ===== skill card ===== */
.yng-card{position:relative;display:flex;flex-direction:column;padding:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;text-align:left;color:inherit;transition:box-shadow 200ms ease,transform 200ms ease,border-color 200ms ease;}
.yng-card:hover{box-shadow:0 2px 8px rgba(0,0,0,0.04);border-color:var(--dsw-alias-border-l2);}
.yng-card:active{transform:scale(0.99);}
.yng-card.highlighted{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,var(--dsw-alias-bg-layer-1));}
.yng-card.highlighted::after{content:"";position:absolute;inset:0;border-radius:inherit;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);opacity:0;pointer-events:none;animation:yngWash 1600ms cubic-bezier(0.16,1,0.3,1) both;}
@keyframes yngWash{0%{opacity:0;transform:scale(0.98);}24%{opacity:0.62;transform:scale(1);}100%{opacity:0;transform:scale(1);}}
.yng-card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}
.yng-card-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;}
.yng-card-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;}
.yng-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:2px 8px;border-radius:9999px;white-space:nowrap;flex:none;}
.yng-badge.applied{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);}
.yng-badge.notApplied{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.yng-badge.problem{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);}
.yng-card-desc{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.9em;}
.yng-card-footer{position:relative;display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px;min-height:24px;}
.yng-card-tags{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0;transition:opacity 150ms ease;}
.yng-card.actionable:hover .yng-card-tags,.yng-card.actionable:focus-within .yng-card-tags{opacity:0;}
.yng-tagpill{display:inline-block;padding:3px 9px;border-radius:9999px;font-size:11px;font-weight:500;letter-spacing:0.03em;}
/* hover 应用/收回按钮直接覆盖在 footer 行右侧（与标签交叉淡入淡出），不常驻占位，卡片底部不留空白 */
.yng-card-action{position:absolute;top:50%;right:0;transform:translateY(-50%);display:flex;justify-content:flex-end;align-items:center;gap:6px;opacity:0;pointer-events:none;transition:opacity 150ms ease;}
.yng-card.actionable:hover .yng-card-action,.yng-card.actionable:focus-within .yng-card-action{opacity:1;pointer-events:auto;}
.yng-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;border:none;white-space:nowrap;transition:background 200ms ease,transform 200ms ease,border-color 200ms ease,color 200ms ease;}
.yng-btn:active{transform:scale(0.98);}
.yng-btn.primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.yng-btn.primary:hover{opacity:0.88;}
.yng-btn.secondary{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);}
.yng-btn.secondary:hover{border-color:var(--dsw-alias-border-l2);}
.yng-btn.danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);}
.yng-btn:disabled{cursor:default;opacity:0.55;transform:none;}
.yng-btn.lg{padding:7px 14px;font-size:12px;border-radius:6px;}

/* ===== empty states ===== */
.yng-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-secondary);padding:48px 32px;text-align:center;}
.yng-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}
.yng-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}

/* ===== detail drawer ===== */
.yng-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.15);z-index:200;overflow:hidden;animation:yngFadeIn 200ms ease-out both;}
.yng-overlay.closing{animation:yngFadeOut 150ms ease-out both;}
@keyframes yngFadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes yngFadeOut{from{opacity:1;}to{opacity:0;}}
.yng-drawer{position:absolute;right:0;top:0;bottom:0;width:340px;max-width:calc(100% - 280px);background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);padding:20px 24px;overflow-y:auto;animation:yngSlideIn 300ms cubic-bezier(0.16,1,0.3,1) both;}
.yng-drawer.closing{animation:yngSlideOut 250ms ease-out both;}
@keyframes yngSlideIn{from{transform:translateX(100%);}to{transform:translateX(0);}}
@keyframes yngSlideOut{from{transform:translateX(0);}to{transform:translateX(100%);}}
.yng-drawer-header{display:flex;justify-content:space-between;align-items:flex-start;}
.yng-drawer-title{font-size:15px;font-weight:600;margin:0;flex:1;min-width:0;overflow-wrap:anywhere;}
.yng-drawer-x{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:background 200ms ease,color 200ms ease;}
.yng-drawer-x:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary);}
.yng-drawer-desc{font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary);}
.yng-section{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);}
.yng-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:8px;}
.yng-targetrow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;transition:background 200ms ease;}
.yng-targetrow:hover{background:var(--dsw-alias-bg-layer-2);}
.yng-targetrow-main{display:flex;flex-direction:column;gap:3px;min-width:0;}
.yng-targetrow-name{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);flex-wrap:wrap;}
.yng-dot{width:7px;height:7px;border-radius:50%;flex:none;}
.yng-dot.applied{background:var(--dsw-alias-state-success-primary);}
.yng-dot.notApplied{background:var(--dsw-alias-border-l2);}
.yng-dot.problem{background:var(--dsw-alias-state-error-primary);}
.yng-issuetext{font-size:11px;color:var(--dsw-alias-state-warn-primary);line-height:1.5;}
.yng-linktarget{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
.yng-mono{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;}
.yng-pre{margin:0;font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;max-height:180px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px;background:var(--dsw-alias-bg-base);}

/* ===== sticky batch bar ===== */
.yng-batchbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 20px;background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1);animation:yngFadeInUp 300ms cubic-bezier(0.16,1,0.3,1) both;}
@keyframes yngFadeInUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
.yng-batchlabel{font-size:11px;color:var(--dsw-alias-label-secondary);}
.yng-batchbuttons{display:flex;gap:6px;align-items:center;}

/* ===== inline error bar ===== */
.yng-errorbar{flex:none;margin:10px 20px 0;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,transparent);}
.yng-errorbar ul{margin:6px 0 0;padding-left:16px;}
.yng-errorbar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;}

/* ===== confirm modal ===== */
.yng-modal-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.15);z-index:300;display:flex;align-items:center;justify-content:center;animation:yngFadeIn 200ms ease-out both;}
.yng-modal{width:480px;max-width:calc(100% - 48px);max-height:70%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.12);animation:yngScaleIn 200ms cubic-bezier(0.16,1,0.3,1) both;}
.yng-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);padding:16px 20px 0;}
.yng-modal-hint{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 20px 0;line-height:1.6;}
.yng-modal-list{margin:10px 20px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);overflow:auto;font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;}
.yng-modal-actions{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px 16px;}

/* ===== toast ===== */
.yng-toast{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:500;max-width:440px;width:calc(100% - 48px);display:flex;align-items:flex-start;gap:8px;padding:10px 16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.08);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);animation:yngFadeIn 160ms ease-out both;}
.yng-toast.exiting{animation:yngFadeOut 120ms ease-in both;}
.yng-toast-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;flex:none;}

/* ===== settings drawer (影子 settings-drawer port) ===== */
.yng-settings-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.08);z-index:220;animation:yngFadeIn 250ms ease both;}
.yng-settings-backdrop.closing{animation:yngFadeOut 150ms ease-out both;}
.yng-settings{position:absolute;right:0;top:0;bottom:0;width:380px;max-width:calc(100% - 160px);background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;overflow:hidden;animation:yngSlideIn 300ms cubic-bezier(0.32,0.72,0,1) both;}
.yng-settings.closing{animation:yngSlideOut 250ms ease-out both;}
.yng-settings-header{display:flex;align-items:center;justify-content:space-between;padding:24px 24px 0;flex:none;}
.yng-settings-header h2{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;}
.yng-settings-close{width:28px;height:28px;border-radius:6px;border:none;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:background 200ms ease,color 200ms ease;padding:0;}
.yng-settings-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-primary);}
.yng-settings-body{flex:1;min-height:0;overflow-y:auto;padding:24px;}
.yng-settings-section{margin-bottom:28px;}
.yng-settings-section:last-child{margin-bottom:0;}
.yng-settings-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--dsw-alias-label-secondary);margin-bottom:12px;}
.yng-pathcard{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px;transition:border-color 200ms ease;}
.yng-pathcard:hover{border-color:var(--dsw-alias-border-l2);}
.yng-pathcard-icon{width:32px;height:32px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-secondary);}
.yng-pathcard-icon svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
.yng-pathcard-info{flex:1;min-width:0;}
.yng-pathcard-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);margin-bottom:2px;display:flex;align-items:center;gap:6px;}
.yng-defaultbadge{font-size:10px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);padding:1px 6px;border-radius:3px;letter-spacing:0.02em;}
.yng-pathcard-value{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.yng-pathcard-action{width:28px;height:28px;border-radius:6px;border:none;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary);flex:none;transition:color 200ms ease,background 200ms ease;padding:0;}
.yng-pathcard-action svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.yng-pathcard-action:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
.yng-pathcard-action.danger:hover{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
.yng-addbtn{width:100%;padding:12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;background:transparent;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-top:8px;transition:border-color 200ms ease,color 200ms ease;font-family:inherit;}
.yng-addbtn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.yng-taglist{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;}
.yng-tagrow{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;transition:opacity 150ms ease,background 150ms ease;}
.yng-tagrow.dragging{opacity:0.4;}
.yng-tagrow.drop-above{box-shadow:0 -2px 0 0 var(--dsw-alias-brand-primary);}
.yng-tagrow:active{cursor:grabbing;}
.yng-tagrow:first-child{border-radius:10px 10px 0 0;}
.yng-tagrow:last-child{border-bottom:none;border-radius:0 0 10px 10px;}
.yng-tagrow:only-child{border-radius:10px;}
.yng-tagrow:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);}
.yng-tagedrag{color:var(--dsw-alias-label-secondary);opacity:0.4;transition:opacity 150ms ease;flex:none;display:flex;align-items:center;}
.yng-tagedrag svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;}
.yng-tagrow:hover .yng-tagedrag{opacity:0.8;}
.yng-tagcolorwrap{position:relative;flex:none;}
.yng-tagdot{width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 150ms ease;border:none;padding:0;}
.yng-tagdot:hover{transform:scale(1.15);}
.yng-tagdot svg{width:10px;height:10px;fill:currentColor;}
.yng-tagpicker{position:absolute;top:28px;left:-4px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;box-shadow:0 4px 16px rgba(0,0,0,0.08);display:grid;grid-template-columns:repeat(8,1fr);gap:6px;width:200px;z-index:230;}
.yng-tagpicker-option{width:16px;height:16px;border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 100ms ease;border:none;padding:0;}
.yng-tagpicker-option svg{width:8px;height:8px;fill:currentColor;}
.yng-tagpicker-option:hover{transform:scale(1.25);}
.yng-tagpicker-option.selected{box-shadow:0 0 0 2px var(--dsw-alias-bg-overlay),0 0 0 3px var(--dsw-alias-label-primary);}
.yng-tagname-area{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;}
.yng-tagname{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);padding:2px 4px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.yng-tagname:hover{background:var(--dsw-alias-bg-layer-2);}
.yng-tagname-input{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);border:none;background:var(--dsw-alias-bg-base);outline:none;padding:4px 6px;border-radius:4px;box-shadow:0 0 0 2px var(--dsw-alias-border-l1);width:100%;min-width:0;font-family:inherit;}
.yng-tagcount{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}
.yng-tagactions{display:flex;align-items:center;gap:2px;opacity:0;transition:opacity 100ms ease;}
.yng-tagrow:hover .yng-tagactions,.yng-tagrow:focus-within .yng-tagactions{opacity:1;}
.yng-tagactionbtn{width:28px;height:28px;border-radius:4px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;transition:background 100ms ease,color 100ms ease;padding:0;font-family:inherit;}
.yng-tagactionbtn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;}
.yng-tagactionbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.yng-tagactionbtn.danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);}
.yng-tagactionbtn.confirm{width:auto;padding:0 8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);}
.yng-tagnewrow{display:flex;align-items:center;gap:10px;margin-top:8px;padding:4px 2px;}
.yng-tagempty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 2px;}
.yng-settings-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:10px;opacity:0.8;}

@media (prefers-reduced-motion: reduce){
  .yng-root *,.yng-root *::before,.yng-root *::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important;}
}
`;

    /* ---------------------------------------------------------------- */
    /* icons                                                              */
    /* ---------------------------------------------------------------- */

    function PanelIcon({ size = 18 }) {
      return jsxs("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        "aria-hidden": true,
        style: { display: "block", flex: "none" },
        children: [
          jsx("rect", { x: 7.5, y: 3.5, width: 13, height: 13, rx: 3.5, fill: "currentColor", opacity: 0.35 }),
          jsx("rect", { x: 3.5, y: 7.5, width: 13, height: 13, rx: 3.5, fill: "currentColor" }),
        ],
      });
    }

    function RefreshIcon() {
      return jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": true, children: jsx("path", { d: "M20 11.5a8 8 0 1 0-2.2 6M20 5v6.5h-6.5" }) });
    }

    function PlusIcon() {
      return jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": true, children: jsx("path", { d: "M12 5v14M5 12h14" }) });
    }

    function ChevronIcon() {
      return jsx("svg", {
        viewBox: "0 0 24 24",
        width: 10,
        height: 10,
        "aria-hidden": true,
        style: { display: "block" },
        children: jsx("path", { d: "M15 6l-6 6 6 6", stroke: "currentColor", fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }),
      });
    }

    function CloseIcon() {
      return jsx("svg", {
        viewBox: "0 0 24 24",
        width: 14,
        height: 14,
        "aria-hidden": true,
        style: { display: "block" },
        children: jsx("path", { d: "M6 6l12 12M18 6L6 18", stroke: "currentColor", fill: "none", strokeWidth: 1.8, strokeLinecap: "round" }),
      });
    }

    function SettingsIcon() {
      return jsx("svg", {
        viewBox: "0 0 24 24",
        "aria-hidden": true,
        children: jsx("path", {
          d: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.02z",
        }),
      });
    }

    function FolderIcon() {
      return jsx("svg", { viewBox: "0 0 24 24", "aria-hidden": true, children: jsx("path", { d: "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" }) });
    }

    function OpenIcon() {
      return jsxs("svg", {
        viewBox: "0 0 24 24",
        "aria-hidden": true,
        children: [
          jsx("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }),
          jsx("path", { d: "M15 3h6v6M10 14L21 3" }),
        ],
      });
    }

    function DotsIcon() {
      return jsxs("svg", {
        viewBox: "0 0 24 24",
        "aria-hidden": true,
        children: [
          jsx("circle", { cx: "9", cy: "6", r: "1.5" }),
          jsx("circle", { cx: "15", cy: "6", r: "1.5" }),
          jsx("circle", { cx: "9", cy: "12", r: "1.5" }),
          jsx("circle", { cx: "15", cy: "12", r: "1.5" }),
          jsx("circle", { cx: "9", cy: "18", r: "1.5" }),
          jsx("circle", { cx: "15", cy: "18", r: "1.5" }),
        ],
      });
    }

    /* ---------------------------------------------------------------- */
    /* hooks                                                              */
    /* ---------------------------------------------------------------- */

    function useYingzi() {
      const [state, setState] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [busy, setBusy] = useState(false);
      const refresh = useCallback(async () => {
        try {
          const next = await api("getState", {});
          setState(next);
          setLoadError(null);
        } catch (error) {
          setLoadError(error);
        }
      }, []);
      const run = useCallback(async (op, args) => {
        setBusy(true);
        try {
          return await api(op, args);
        } finally {
          setBusy(false);
        }
      }, []);
      useEffect(() => {
        void refresh();
      }, [refresh]);
      return { state, setState, loadError, busy, refresh, run };
    }

    /** 影子 toast：自动消退（fade-out），kind = success | warn | info。 */
    function useToast() {
      const [toast, setToast] = useState(null);
      const timerRef = useRef(null);
      const show = useCallback((kind, text) => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        setToast({ kind, text, exiting: false });
        timerRef.current = setTimeout(() => {
          setToast((current) => (current === null ? null : { ...current, exiting: true }));
          timerRef.current = setTimeout(() => setToast(null), 130);
        }, 3200);
      }, []);
      useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
      );
      const dismiss = useCallback(() => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        setToast(null);
      }, []);
      return { toast, show, dismiss };
    }

    /* ---------------------------------------------------------------- */
    /* components                                                         */
    /* ---------------------------------------------------------------- */

    function StatusBadge({ raw, t }) {
      return jsx("span", { className: `yng-badge ${pillOf(raw)}`, children: t(`statusRaw.${raw}`) });
    }

    function TagPill({ tag, tagMeta }) {
      const palette = tagColorOf(tag, tagMeta);
      return jsx("span", { className: "yng-tagpill", style: { background: palette.bg, color: palette.text }, children: tag });
    }

    function useDismissable(open, onCloseRef) {
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (onCloseRef.current !== null && !onCloseRef.current.contains(event.target)) onCloseRef.current.close();
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") onCloseRef.current.close();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open, onCloseRef]);
    }

    function TargetDropdown({ targets, value, onChange, disabled, t }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      const controllerRef = useRef(null);
      controllerRef.current = { contains: (node) => rootRef.current !== null && rootRef.current.contains(node), close: () => setOpen(false) };
      useDismissable(open, controllerRef);
      const selected = value === "" ? null : targets.find((item) => item.id === value) ?? null;
      return jsxs("div", {
        className: `yng-dd${open ? " open" : ""}`,
        ref: rootRef,
        children: [
          jsxs("button", {
            type: "button",
            className: "yng-dd-trigger",
            disabled,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            onClick: () => setOpen((current) => !current),
            children: [
              jsx("span", { className: "yng-dd-label", children: selected === null ? t("target.all") : selected.name }),
              jsx("span", { className: "yng-dd-chevron", children: jsx(ChevronIcon, {}) }),
            ],
          }),
          open
            ? jsx("div", {
                className: "yng-dd-menu",
                role: "listbox",
                children: [
                  jsx("div", {
                    key: "__all__",
                    role: "option",
                    "aria-selected": value === "",
                    className: `yng-dd-item${value === "" ? " active" : ""}`,
                    onClick: () => {
                      setOpen(false);
                      onChange("");
                    },
                    children: jsx("span", { className: "yng-dd-name", children: t("target.all") }),
                  }),
                  targets.map((target) =>
                    jsxs("div", {
                      role: "option",
                      "aria-selected": value === target.id,
                      className: `yng-dd-item${value === target.id ? " active" : ""}`,
                      onClick: () => {
                        setOpen(false);
                        onChange(target.id);
                      },
                      children: [
                        jsxs("span", { className: "yng-dd-name", children: [target.name, target.isDefault ? jsx("span", { className: "yng-group-count", style: { marginLeft: 6 }, children: t("target.default") }) : null] }),
                        jsx("span", { className: "yng-dd-path", title: target.skillsPath, children: target.skillsPath }),
                      ],
                    }, target.id),
                  ),
                ],
              })
            : null,
        ],
      });
    }

    function StatusFilterDropdown({ value, onChange, t }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      const controllerRef = useRef(null);
      controllerRef.current = { contains: (node) => rootRef.current !== null && rootRef.current.contains(node), close: () => setOpen(false) };
      useDismissable(open, controllerRef);
      const options = [
        { id: "", label: t("status.all") },
        { id: "applied", label: t("status.applied") },
        { id: "notApplied", label: t("status.notApplied") },
        { id: "problem", label: t("status.problem") },
      ];
      const current = options.find((option) => option.id === value) ?? options[0];
      return jsxs("div", {
        className: `yng-dd yng-statusdd${open ? " open" : ""}`,
        ref: rootRef,
        children: [
          jsxs("button", {
            type: "button",
            className: "yng-dd-trigger",
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            onClick: () => setOpen((state) => !state),
            children: [
              jsx("span", { className: "yng-dd-label", children: current.label }),
              jsx("span", { className: "yng-dd-chevron", children: jsx(ChevronIcon, {}) }),
            ],
          }),
          open
            ? jsx("div", {
                className: "yng-dd-menu",
                role: "listbox",
                style: { left: "auto", right: 0 },
                children: options.map((option) =>
                  jsx("div", {
                    role: "option",
                    "aria-selected": value === option.id,
                    className: `yng-dd-item${value === option.id ? " active" : ""}`,
                    onClick: () => {
                      setOpen(false);
                      onChange(option.id);
                    },
                    children: jsx("span", { className: "yng-dd-name", children: option.label }),
                  }, option.id || "__all"),
                ),
              })
            : null,
        ],
      });
    }

    function SkillCard({ skill, raw, highlighted, busy, onApply, onWithdraw, onOpen, t }) {
      return jsxs("div", {
        className: `yng-card${highlighted ? " highlighted" : ""}${raw !== null ? " actionable" : ""}`,
        role: "button",
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        },
        children: [
          jsxs("div", {
            className: "yng-card-header",
            children: [
              jsx("span", { className: "yng-card-title", children: jsx("span", { className: "yng-card-title-text", title: skill.displayName, children: skill.displayName }) }),
              raw !== null ? jsx(StatusBadge, { raw, t }) : null,
            ],
          }),
          jsx("div", { className: "yng-card-desc", children: skill.description || "—" }),
          jsxs("div", {
            className: "yng-card-footer",
            children: [
              jsx("div", {
                className: "yng-card-tags",
                children: skill.tags.length > 0 ? skill.tags.map((name) => jsx(TagPill, { tag: name, tagMeta: null }, name)) : null,
              }),
              raw !== null
                ? jsxs("div", {
                    className: "yng-card-action",
                    children: [
                      raw !== "enabled"
                        ? jsx("button", {
                            type: "button",
                            className: "yng-btn primary",
                            disabled: busy,
                            "aria-busy": busy,
                            onClick: (event) => {
                              event.stopPropagation();
                              onApply();
                            },
                            children: t("action.apply"),
                          })
                        : null,
                      raw === "enabled"
                        ? jsx("button", {
                            type: "button",
                            className: "yng-btn secondary",
                            disabled: busy,
                            onClick: (event) => {
                              event.stopPropagation();
                              onWithdraw();
                            },
                            children: t("action.withdraw"),
                          })
                        : null,
                    ],
                  })
                : null,
            ],
          }),
        ],
      });
    }

    function DetailDrawer({ skill, state, busy, closing, onClose, onDeploy, onWithdraw, onReveal, t }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [onClose]);
      const rows = [];
      for (const target of state.targets) {
        const row = (state.targetStatuses[target.id] ?? []).find((item) => item.skillId === skill.id);
        if (row !== undefined) rows.push(row);
      }
      return jsxs("div", {
        className: `yng-overlay${closing ? " closing" : ""}`,
        onClick: onClose,
        children: [
          jsxs("div", {
            className: `yng-drawer${closing ? " closing" : ""}`,
            role: "dialog",
            "aria-label": skill.displayName,
            onClick: (event) => event.stopPropagation(),
            children: [
              jsxs("div", {
                className: "yng-drawer-header",
                children: [
                  jsx("h3", { className: "yng-drawer-title", children: skill.displayName }),
                  jsx("button", { type: "button", className: "yng-drawer-x", "aria-label": t("action.close"), onClick: onClose, children: jsx(CloseIcon, {}) }),
                ],
              }),
              skill.name !== skill.displayName ? jsx("div", { className: "yng-mono", style: { marginTop: 4 }, children: skill.name }) : null,
              jsx("div", { className: "yng-section", children: jsx("div", { className: "yng-drawer-desc", children: skill.description || t("drawer.emptyDesc") }) }),
              jsxs("div", {
                className: "yng-section",
                children: [
                  jsx("div", { className: "yng-section-title", children: t("drawer.statusByTarget") }),
                  rows.map((row) =>
                    jsxs("div", {
                      className: "yng-targetrow",
                      children: [
                        jsxs("div", {
                          className: "yng-targetrow-main",
                          children: [
                            jsxs("span", { className: "yng-targetrow-name", children: [jsx("span", { className: `yng-dot ${pillOf(row.status)}` }), row.targetName, jsx(StatusBadge, { raw: row.status, t })] }),
                            row.issueCode !== null ? jsx("span", { className: "yng-issuetext", children: t(`issue.${row.issueCode}`) }) : null,
                            row.linkTarget !== null ? jsx("span", { className: "yng-linktarget", title: row.linkTarget, children: `${t("issue.linkTarget")}: ${row.linkTarget}` }) : null,
                          ],
                        }),
                        jsxs("div", {
                          style: { display: "flex", gap: 6, flex: "none" },
                          children: [
                            row.status !== "enabled"
                              ? jsx("button", { type: "button", className: "yng-btn primary", disabled: busy, onClick: () => onDeploy(row.targetId), children: t("action.apply") })
                              : null,
                            row.status === "enabled"
                              ? jsx("button", { type: "button", className: "yng-btn secondary", disabled: busy, onClick: () => onWithdraw(row.targetId), children: t("action.withdraw") })
                              : null,
                          ],
                        }),
                      ],
                    }, row.id),
                  ),
                ],
              }),
              jsxs("div", {
                className: "yng-section",
                children: [
                  jsx("div", { className: "yng-section-title", children: t("drawer.libraryPath") }),
                  jsx("div", { className: "yng-mono", children: skill.path }),
                  jsx("div", { style: { marginTop: 8 }, children: jsx("button", { type: "button", className: "yng-btn secondary", disabled: busy, onClick: () => onReveal(skill.path), children: t("action.reveal") }) }),
                ],
              }),
              jsxs("div", {
                className: "yng-section",
                children: [
                  jsx("div", { className: "yng-section-title", children: t("drawer.preview") }),
                  jsx("pre", { className: "yng-pre", children: skill.contentPreview || t("drawer.noPreview") }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    function ConfirmModal({ title, hint, listText, confirmLabel, danger, busy, onConfirm, onCancel, t }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onCancel();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [onCancel]);
      return jsxs("div", {
        className: "yng-modal-overlay",
        onClick: onCancel,
        children: [
          jsxs("div", {
            className: "yng-modal",
            role: "alertdialog",
            "aria-label": title,
            onClick: (event) => event.stopPropagation(),
            children: [
              jsx("div", { className: "yng-modal-title", children: title }),
              jsx("div", { className: "yng-modal-hint", children: hint }),
              listText !== null ? jsx("div", { className: "yng-modal-list", children: listText }) : null,
              jsxs("div", {
                className: "yng-modal-actions",
                children: [
                  jsx("button", { type: "button", className: "yng-btn secondary lg", disabled: busy, onClick: onCancel, children: t("action.cancel") }),
                  jsx("button", { type: "button", className: `yng-btn lg ${danger ? "danger" : "primary"}`, disabled: busy, "aria-busy": busy, onClick: onConfirm, children: confirmLabel }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /* ---------------------------------------------------------------- */
    /* settings drawer (影子 settings port)                                */
    /* ---------------------------------------------------------------- */

    function PathCard({ name, badge, value, openTitle, onOpen, removeTitle, onRemove }) {
      return jsxs("div", {
        className: "yng-pathcard",
        children: [
          jsx("div", { className: "yng-pathcard-icon", children: jsx(FolderIcon, {}) }),
          jsxs("div", { className: "yng-pathcard-info", children: [jsxs("div", { className: "yng-pathcard-name", children: [name, badge !== null ? badge : null] }), jsx("div", { className: "yng-pathcard-value", title: value, children: value })] }),
          jsx("button", { type: "button", className: "yng-pathcard-action", title: openTitle, "aria-label": openTitle, onClick: onOpen, children: jsx(OpenIcon, {}) }),
          onRemove
            ? jsx("button", { type: "button", className: "yng-pathcard-action danger", title: removeTitle, "aria-label": removeTitle, onClick: onRemove, children: jsx(CloseIcon, {}) })
            : null,
        ],
      });
    }

    function SettingsDrawer({ state, busy, closing, onClose, t, onAddTarget, onRemoveTarget, onRenameTag, onSetTagColor, onDeleteTag, onReorderTags, onCreateTag, onReveal }) {
      const [pickerTag, setPickerTag] = useState(null);
      const [editingTag, setEditingTag] = useState(null);
      const [editValue, setEditValue] = useState("");
      const [confirmDeleteTag, setConfirmDeleteTag] = useState(null);
      const [showNewTagInput, setShowNewTagInput] = useState(false);
      const [newTagName, setNewTagName] = useState("");
      const [dragIdx, setDragIdx] = useState(null);
      const [dropIdx, setDropIdx] = useState(null);
      const pickerWrapRef = useRef(null);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [onClose]);

      useEffect(() => {
        if (pickerTag === null) return undefined;
        const onPointerDown = (event) => {
          if (pickerWrapRef.current !== null && !pickerWrapRef.current.contains(event.target)) setPickerTag(null);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
      }, [pickerTag]);

      const tagCounts = useMemo(() => {
        const counts = {};
        for (const skill of state.skills) {
          for (const name of skill.tags) counts[name] = (counts[name] ?? 0) + 1;
        }
        return counts;
      }, [state.skills]);

      const tagRows = state.tagMeta;

      const submitRename = (oldName) => {
        const trimmed = editValue.trim();
        setEditingTag(null);
        if (trimmed === "" || trimmed === oldName) return;
        onRenameTag(oldName, trimmed);
      };

      const submitNewTag = () => {
        const trimmed = newTagName.trim();
        setShowNewTagInput(false);
        setNewTagName("");
        if (trimmed === "") return;
        onCreateTag(trimmed);
      };

      const handleDrop = (fromIdx, toIdx) => {
        setDragIdx(null);
        setDropIdx(null);
        if (fromIdx === null || fromIdx === toIdx) return;
        const reordered = [...tagRows];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, moved);
        onReorderTags(reordered.map((row) => row.name));
      };

      return jsxs("div", {
        className: `yng-settings-backdrop${closing ? " closing" : ""}`,
        onClick: onClose,
        children: [
          jsxs("aside", {
            className: `yng-settings${closing ? " closing" : ""}`,
            role: "dialog",
            "aria-label": t("settings.title"),
            onClick: (event) => event.stopPropagation(),
            children: [
              jsxs("div", {
                className: "yng-settings-header",
                children: [
                  jsx("h2", { children: t("settings.title") }),
                  jsx("button", { type: "button", className: "yng-settings-close", "aria-label": t("action.close"), onClick: onClose, children: jsx(CloseIcon, {}) }),
                ],
              }),
              jsxs("div", {
                className: "yng-settings-body",
                children: [
                  jsxs("div", {
                    className: "yng-settings-section",
                    children: [
                      jsx("div", { className: "yng-settings-label", children: t("settings.section.root") }),
                      jsx(PathCard, {
                        name: t("settings.libraryName"),
                        badge: null,
                        value: state.skillsRoot,
                        openTitle: t("settings.open"),
                        onOpen: () => onReveal(state.skillsRoot),
                      }),
                    ],
                  }),
                  jsxs("div", {
                    className: "yng-settings-section",
                    children: [
                      jsx("div", { className: "yng-settings-label", children: t("settings.section.targets") }),
                      state.targets.map((target) =>
                        jsx(PathCard, {
                          name: target.name,
                          badge: target.isDefault ? jsx("span", { className: "yng-defaultbadge", children: t("target.default") }) : null,
                          value: target.path,
                          openTitle: t("settings.open"),
                          onOpen: () => onReveal(target.path),
                          removeTitle: t("settings.remove"),
                          onRemove: target.isDefault ? null : () => onRemoveTarget(target),
                        }, target.id),
                      ),
                      jsx("button", { type: "button", className: "yng-addbtn", disabled: busy, onClick: onAddTarget, children: `+ ${t("settings.addTarget")}` }),
                    ],
                  }),
                  jsxs("div", {
                    className: "yng-settings-section",
                    children: [
                      jsx("div", { className: "yng-settings-label", children: t("settings.section.tags") }),
                      tagRows.length > 0
                        ? jsx("div", {
                            className: "yng-taglist",
                            children: tagRows.map((row, idx) => {
                              const palette = tagColorOf(row.name, state.tagMeta);
                              return jsxs("div", {
                                className: `yng-tagrow${dragIdx === idx ? " dragging" : ""}${dropIdx === idx ? " drop-above" : ""}`,
                                draggable: true,
                                onDragStart: () => setDragIdx(idx),
                                onDragOver: (event) => {
                                  event.preventDefault();
                                  setDropIdx(idx);
                                },
                                onDragLeave: () => setDropIdx(null),
                                onDrop: (event) => {
                                  event.preventDefault();
                                  handleDrop(dragIdx, idx);
                                },
                                onDragEnd: () => {
                                  setDragIdx(null);
                                  setDropIdx(null);
                                },
                                children: [
                                  jsx("div", { className: "yng-tagedrag", children: jsx(DotsIcon, {}) }),
                                  jsxs("div", {
                                    className: "yng-tagcolorwrap",
                                    ref: pickerTag === row.name ? pickerWrapRef : null,
                                    children: [
                                      jsx("button", {
                                        type: "button",
                                        className: "yng-tagdot",
                                        style: { background: palette.bg, color: palette.text },
                                        onClick: () => setPickerTag(pickerTag === row.name ? null : row.name),
                                        children: jsx("svg", { viewBox: "0 0 24 24", children: jsx("circle", { cx: "12", cy: "12", r: "5" }) }),
                                      }),
                                      pickerTag === row.name
                                        ? jsx("div", {
                                            className: "yng-tagpicker",
                                            children: TAG_PALETTE.map((color, colorIndex) =>
                                              jsx("button", {
                                                type: "button",
                                                className: `yng-tagpicker-option${colorIndex === (row.colorIndex >= 0 ? row.colorIndex % 16 : -1) ? " selected" : ""}`,
                                                style: { background: color.bg, color: color.text },
                                                onClick: () => {
                                                  setPickerTag(null);
                                                  onSetTagColor(row.name, colorIndex);
                                                },
                                                children: jsx("svg", { viewBox: "0 0 24 24", children: jsx("circle", { cx: "12", cy: "12", r: "5" }) }),
                                              }, colorIndex),
                                            ),
                                          })
                                        : null,
                                    ],
                                  }),
                                  jsxs("div", {
                                    className: "yng-tagname-area",
                                    children: [
                                      editingTag === row.name
                                        ? jsx("input", {
                                            className: "yng-tagname-input",
                                            value: editValue,
                                            autoFocus: true,
                                            disabled: busy,
                                            onChange: (event) => setEditValue(event.target.value),
                                            onKeyDown: (event) => {
                                              if (event.key === "Enter") submitRename(row.name);
                                              if (event.key === "Escape") setEditingTag(null);
                                            },
                                            onBlur: () => submitRename(row.name),
                                          })
                                        : jsx("span", {
                                            className: "yng-tagname",
                                            title: t("settings.confirm") === "确认" ? "点击重命名" : "Click to rename",
                                            onClick: () => {
                                              setEditingTag(row.name);
                                              setEditValue(row.name);
                                            },
                                            children: row.name,
                                          }),
                                      jsx("span", { className: "yng-tagcount", children: fmt(t("settings.tagCount"), { n: tagCounts[row.name] ?? 0 }) }),
                                    ],
                                  }),
                                  jsxs("div", {
                                    className: "yng-tagactions",
                                    children: [
                                      confirmDeleteTag === row.name
                                        ? jsx("button", { type: "button", className: "yng-tagactionbtn confirm", disabled: busy, onClick: () => { setConfirmDeleteTag(null); onDeleteTag(row.name); }, children: t("settings.confirm") })
                                        : null,
                                      confirmDeleteTag === row.name
                                        ? jsx("button", { type: "button", className: "yng-tagactionbtn", onClick: () => setConfirmDeleteTag(null), children: t("action.cancel") })
                                        : jsx("button", { type: "button", className: "yng-tagactionbtn danger", title: t("settings.remove"), "aria-label": t("settings.remove"), onClick: () => setConfirmDeleteTag(row.name), children: jsx(CloseIcon, {}) }),
                                    ],
                                  }),
                                ],
                              }, row.name);
                            }),
                          })
                        : jsx("div", { className: "yng-tagempty", children: t("settings.emptyTags") }),
                      showNewTagInput
                        ? jsxs("div", {
                            className: "yng-tagnewrow",
                            children: [
                              jsx("span", { className: "yng-tagdot", style: { background: TAG_PALETTE[0].bg, opacity: 0.5 } }),
                              jsx("input", {
                                className: "yng-tagname-input",
                                placeholder: t("settings.newTagPlaceholder"),
                                value: newTagName,
                                autoFocus: true,
                                disabled: busy,
                                onChange: (event) => setNewTagName(event.target.value),
                                onKeyDown: (event) => {
                                  if (event.key === "Enter") submitNewTag();
                                  if (event.key === "Escape") {
                                    setShowNewTagInput(false);
                                    setNewTagName("");
                                  }
                                },
                                onBlur: submitNewTag,
                              }),
                            ],
                          })
                        : jsx("button", { type: "button", className: "yng-addbtn", disabled: busy, onClick: () => setShowNewTagInput(true), children: `+ ${t("settings.newTag")}` }),
                      jsx("div", { className: "yng-settings-hint", children: t("settings.syncHint") }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    /* ---------------------------------------------------------------- */
    /* main panel                                                         */
    /* ---------------------------------------------------------------- */

    function YingziPanel({ ctx, t }) {
      const { state, setState, loadError, busy, refresh, run } = useYingzi();
      const [targetId, setTargetId] = useState("");
      const [statusFilter, setStatusFilter] = useState("");
      const [query, setQuery] = useState("");
      const [tag, setTag] = useState("");
      const { toast, show: showToast } = useToast();
      const [errorBar, setErrorBar] = useState(null);
      const [drawerId, setDrawerId] = useState(null);
      const [drawerClosing, setDrawerClosing] = useState(false);
      const [confirmState, setConfirmState] = useState(null);
      const [highlightedId, setHighlightedId] = useState(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [settingsClosing, setSettingsClosing] = useState(false);

      const hasToken = typeof globalThis[TOKEN_KEY] === "string";

      const flash = useCallback((kind, text) => showToast(kind, text), [showToast]);

      const closeDrawer = useCallback(() => {
        setDrawerClosing(true);
        setTimeout(() => {
          setDrawerId(null);
          setDrawerClosing(false);
        }, 250);
      }, []);

      const finishReport = useCallback(
        (report, okText) => {
          if (report.errors.length > 0) {
            setErrorBar({ title: t("report.title"), lines: report.errors });
          }
          if (report.conflicts.length > 0) {
            setConfirmState({ kind: "overwrite", items: report.items.filter((item) => item.outcome === "conflict") });
            return;
          }
          if (report.errors.length === 0) {
            if (report.skipped > 0) {
              flash("warn", fmt(t("toast.partial"), { changed: report.changed, skipped: report.skipped }));
            } else {
              flash("success", okText);
            }
          } else if (report.changed > 0 || report.skipped > 0) {
            flash("warn", fmt(t("toast.partial"), { changed: report.changed, skipped: report.skipped }));
          }
        },
        [flash, t],
      );

      const doOp = useCallback(
        async (op, skillId, tid, overwrite = false) => {
          try {
            const report = await run(op, { skillId, targetId: tid, overwrite });
            finishReport(report, op === "deploy" ? t("toast.applied") : t("toast.withdrawn"));
            await refresh();
          } catch (error) {
            setErrorBar({ title: messageOf(error), lines: null });
          }
        },
        [run, finishReport, refresh, flash, t],
      );

      const doImport = useCallback(async () => {
        let dir = null;
        try {
          dir = await ctx.uiWorkspace.pickDirectory();
        } catch (error) {
          setErrorBar({ title: messageOf(error), lines: null });
          return;
        }
        if (dir === null || dir === undefined) return;
        try {
          const data = await run("importSkill", { sourcePath: dir });
          setState(data.state);
          setHighlightedId(data.skillId);
          setTimeout(() => setHighlightedId(null), 1700);
          flash("success", fmt(t("toast.imported"), { id: data.skillId }));
        } catch (error) {
          setErrorBar({ title: `${t("error.import")}: ${messageOf(error)}`, lines: null });
        }
      }, [ctx, run, setState, flash, t]);

      const doReveal = useCallback(
        async (path) => {
          try {
            await run("reveal", { path });
          } catch (error) {
            setErrorBar({ title: messageOf(error), lines: null });
          }
        },
        [run],
      );

      /* ---------- settings operations ---------- */

      const doSettingsOp = useCallback(
        async (op, args) => {
          try {
            const res = await run(op, args);
            setState(res.state);
            return true;
          } catch (error) {
            setErrorBar({ title: messageOf(error), lines: null });
            return false;
          }
        },
        [run, setState],
      );

      const openSettings = useCallback(() => {
        setDrawerId(null);
        setDrawerClosing(false);
        setSettingsClosing(false);
        setSettingsOpen(true);
      }, []);

      const closeSettings = useCallback(() => {
        setSettingsClosing(true);
        setTimeout(() => {
          setSettingsOpen(false);
          setSettingsClosing(false);
        }, 250);
      }, []);

      const doAddTarget = useCallback(async () => {
        let dir = null;
        try {
          dir = await ctx.uiWorkspace.pickDirectory();
        } catch (error) {
          setErrorBar({ title: messageOf(error), lines: null });
          return;
        }
        if (dir === null || dir === undefined) return;
        await doSettingsOp("addTarget", { path: dir });
      }, [ctx, doSettingsOp]);

      /* ---------- derived views ---------- */

      const skills = state?.skills ?? [];
      const targets = state?.targets ?? [];
      const tagMeta = state?.tagMeta ?? [];
      const selectedTarget = targetId === "" ? null : targets.find((item) => item.id === targetId) ?? null;
      const statusesForSelection = targetId === "" ? null : state?.targetStatuses?.[targetId] ?? null;

      const allTags = useMemo(() => {
        const names = tagMeta.map((meta) => meta.name);
        for (const skill of skills) {
          for (const name of skill.tags) names.push(name);
        }
        return [...new Set(names)];
      }, [state, tagMeta, skills]);

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return skills.filter((skill) => {
          if (tag === "__none__" && skill.tags.length > 0) return false;
          if (tag !== "" && tag !== "__none__" && !skill.tags.includes(tag)) return false;
          if (q === "") return true;
          return (
            skill.displayName.toLowerCase().includes(q) ||
            skill.name.toLowerCase().includes(q) ||
            (skill.description ?? "").toLowerCase().includes(q) ||
            skill.tags.some((name) => name.toLowerCase().includes(q))
          );
        });
      }, [skills, query, tag]);

      const statusOf = useCallback(
        (skillId) => {
          if (statusesForSelection === null) return null;
          const row = statusesForSelection.find((item) => item.skillId === skillId);
          return row === undefined ? null : row.status;
        },
        [statusesForSelection],
      );

      const visibleSkills = useMemo(() => {
        if (statusFilter === "") return filtered;
        return filtered.filter((skill) => pillOf(statusOf(skill.id)) === statusFilter);
      }, [filtered, statusFilter, statusOf]);

      /** 分组：全部技能按首标签（+无标签）；选择目标后按三态（影子分组规则）。 */
      const groups = useMemo(() => {
        if (targetId === "") {
          const byTag = new Map();
          for (const skill of visibleSkills) {
            const key = skill.tags.length > 0 ? skill.tags[0] : "__none__";
            if (!byTag.has(key)) byTag.set(key, []);
            byTag.get(key).push(skill);
          }
          const orderedKeys = [...allTags.filter((name) => byTag.has(name)), ...(byTag.has("__none__") ? ["__none__"] : [])];
          return orderedKeys.map((key) => ({
            key,
            title: key === "__none__" ? t("group.untagged") : key,
            dot: key === "__none__" ? null : tagColorOf(key, tagMeta).bg,
            skills: byTag.get(key),
          }));
        }
        const buckets = { applied: [], notApplied: [], problem: [] };
        for (const skill of visibleSkills) {
          const pill = pillOf(statusOf(skill.id));
          if (pill !== null) buckets[pill].push(skill);
        }
        return [
          { key: "applied", title: t("status.applied"), dot: "var(--dsw-alias-state-success-primary)", skills: buckets.applied },
          { key: "notApplied", title: t("status.notApplied"), dot: "var(--dsw-alias-border-l2)", skills: buckets.notApplied },
          { key: "problem", title: t("status.problem"), dot: "var(--dsw-alias-state-error-primary)", skills: buckets.problem },
        ].filter((group) => group.skills.length > 0);
      }, [targetId, visibleSkills, allTags, statusOf, tagMeta, t]);

      const drawerSkill = drawerId === null ? null : skills.find((skill) => skill.id === drawerId) ?? null;

      /* ---------- confirm flows ---------- */

      const openBatchConfirm = useCallback(
        (mode) => {
          if (selectedTarget === null || visibleSkills.length === 0) return;
          setConfirmState({ kind: mode === "deploy" ? "batchApply" : "batchWithdraw", mode, count: visibleSkills.length, targetId });
        },
        [selectedTarget, visibleSkills, targetId],
      );

      const runConfirmed = useCallback(async () => {
        const current = confirmState;
        if (current === null) return;
        setConfirmState(null);
        try {
          if (current.kind === "overwrite") {
            const aggregated = { changed: 0, skipped: 0, conflicts: [], errors: [], items: [] };
            for (const item of current.items) {
              const report = await run("deploy", { skillId: item.skillId, targetId: item.targetId, overwrite: true });
              aggregated.changed += report.changed;
              aggregated.skipped += report.skipped;
              aggregated.conflicts.push(...report.conflicts);
              aggregated.errors.push(...report.errors);
              aggregated.items.push(...report.items);
            }
            finishReport(aggregated, t("toast.applied"));
            await refresh();
            return;
          }
          if (current.kind === "removeTarget") {
            await doSettingsOp("removeTarget", { targetId: current.targetId });
            return;
          }
          const report = await run(current.mode === "deploy" ? "deployBatch" : "withdrawBatch", {
            skillIds: visibleSkills.map((skill) => skill.id),
            targetId: current.targetId,
            overwrite: false,
          });
          finishReport(report, current.mode === "deploy" ? t("toast.applied") : t("toast.withdrawn"));
          await refresh();
        } catch (error) {
          setErrorBar({ title: messageOf(error), lines: null });
        }
      }, [confirmState, run, visibleSkills, finishReport, refresh, t]);

      const confirmView = useMemo(() => {
        if (confirmState === null) return null;
        if (confirmState.kind === "removeTarget") {
          return {
            title: t("settings.removeTargetTitle"),
            hint: t("settings.removeTargetHint"),
            listText: `${confirmState.targetName}\n${confirmState.targetPath}`,
            confirmLabel: t("settings.remove"),
            danger: true,
          };
        }
        if (confirmState.kind === "overwrite") {
          return {
            title: t("confirm.overwriteTitle"),
            hint: t("confirm.overwriteHint"),
            listText: confirmState.items.map((item) => `${item.skillId} → ${item.message}`).join("\n"),
            confirmLabel: t("action.overwrite"),
            danger: true,
          };
        }
        const targetName = targets.find((item) => item.id === confirmState.targetId)?.name ?? "";
        const actionText = confirmState.mode === "deploy" ? t("confirm.batchApply") : t("confirm.batchWithdraw");
        return {
          title: confirmState.mode === "deploy" ? t("confirm.batchApplyTitle") : t("confirm.batchWithdrawTitle"),
          hint: fmt(t("confirm.batchHint"), { count: confirmState.count, target: targetName, action: actionText }),
          listText: null,
          confirmLabel: actionText,
          danger: false,
        };
      }, [confirmState, targets, t]);

      const selectedRootMissing = selectedTarget !== null && selectedTarget.rootExists === false;

      /* ---------- render ---------- */

      return jsxs("div", {
        className: "yng-root",
        children: [
          jsx("style", { children: CSS }),
          jsxs("div", {
            className: "yng-toolbar",
            children: [
              jsxs("div", {
                className: "yng-toolbar-row",
                children: [
                  jsx(TargetDropdown, {
                    targets,
                    value: targetId,
                    onChange: (next) => {
                      setTargetId(next);
                      setStatusFilter("");
                      setErrorBar(null);
                    },
                    disabled: busy,
                    t,
                  }),
                  jsx("input", {
                    className: "yng-search",
                    value: query,
                    placeholder: t("search.placeholder"),
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  jsx("button", {
                    type: "button",
                    className: "yng-iconbtn",
                    disabled: busy,
                    "aria-label": t("action.refresh"),
                    title: t("action.refresh"),
                    onClick: () => void refresh(),
                    children: jsx(RefreshIcon, {}),
                  }),
                  jsx("button", {
                    type: "button",
                    className: "yng-iconbtn",
                    disabled: busy,
                    "aria-label": t("action.import"),
                    title: t("action.importHint"),
                    onClick: () => void doImport(),
                    children: jsx(PlusIcon, {}),
                  }),
                  jsx("button", {
                    type: "button",
                    className: "yng-iconbtn",
                    "aria-label": t("settings.title"),
                    title: t("settings.title"),
                    onClick: openSettings,
                    children: jsx(SettingsIcon, {}),
                  }),
                ],
              }),
              jsxs("div", {
                className: "yng-filterrow",
                children: [
                  jsx("button", { type: "button", className: `yng-chip${tag === "" ? " active" : ""}`, onClick: () => setTag(""), children: t("tags.all") }),
                  allTags.map((name) =>
                    jsxs("button", {
                      type: "button",
                      className: `yng-chip${tag === name ? " active" : ""}`,
                      onClick: () => setTag(name),
                      children: [jsx("span", { className: "yng-chip-dot", style: { background: tagColorOf(name, tagMeta).bg } }), name],
                    }, name),
                  ),
                  jsx("button", {
                    type: "button",
                    className: `yng-chip notag${tag === "__none__" ? " active" : ""}`,
                    onClick: () => setTag("__none__"),
                    children: t("tags.none"),
                  }),
                  selectedTarget !== null ? jsx(StatusFilterDropdown, { value: statusFilter, onChange: setStatusFilter, t }) : null,
                ],
              }),
            ],
          }),
          !hasToken ? jsx("div", { className: "yng-banner warn", children: jsx("span", { children: t("error.noToken") }) }) : null,
          loadError !== null && hasToken
            ? jsxs("div", {
                className: "yng-banner error",
                children: [
                  jsx("span", { children: `${t("error.loading")}: ${messageOf(loadError)}` }),
                  jsx("button", { type: "button", className: "yng-banner-close", onClick: () => void refresh(), children: t("action.retry") }),
                ],
              })
            : null,
          state !== null && state.issues.length > 0 ? jsx("div", { className: "yng-banner error", children: jsx("span", { children: state.issues.join("；") }) }) : null,
          errorBar !== null
            ? jsxs("div", {
                className: "yng-errorbar",
                role: "alert",
                children: [
                  jsxs("div", {
                    className: "yng-errorbar-head",
                    children: [
                      jsx("span", { children: errorBar.title }),
                      jsx("button", { type: "button", className: "yng-banner-close", onClick: () => setErrorBar(null), children: t("action.dismiss") }),
                    ],
                  }),
                  errorBar.lines !== null && errorBar.lines.length > 0 ? jsx("ul", { children: errorBar.lines.map((line, index) => jsx("li", { children: line }, index)) }) : null,
                ],
              })
            : null,
          state === null
            ? jsx("div", { className: "yng-empty", children: jsx("span", { children: t("loading") }) })
            : skills.length === 0
              ? jsxs("div", { className: "yng-empty", children: [jsx("div", { className: "yng-empty-title", children: t("empty.library") }), jsx("div", { children: t("empty.libraryHint") })] })
              : jsxs(React.Fragment, {
                  children: [
                    jsxs("div", {
                      className: "yng-main",
                      children: [
                        selectedRootMissing ? jsx("div", { className: "yng-hint", style: { marginBottom: 10 }, children: t("empty.targetRoot") }) : null,
                        visibleSkills.length === 0
                          ? jsx("div", { className: "yng-empty", children: jsx("span", { children: t("empty.filter") }) })
                          : groups.map((group) =>
                              jsxs("div", {
                                className: "yng-group",
                                children: [
                                  jsxs("div", {
                                    className: "yng-group-header",
                                    children: [
                                      group.dot !== null ? jsx("span", { className: "yng-group-dot", style: { background: group.dot } }) : null,
                                      jsx("span", { className: "yng-group-title", children: group.title }),
                                      jsx("span", { className: "yng-group-count", children: group.skills.length }),
                                    ],
                                  }),
                                  jsx("div", {
                                    className: "yng-grid",
                                    children: group.skills.map((skill) => {
                                      const raw = statusOf(skill.id);
                                      return jsx(SkillCard, {
                                        skill,
                                        raw,
                                        highlighted: highlightedId === skill.id,
                                        busy,
                                        t,
                                        onApply: () => void doOp("deploy", skill.id, targetId),
                                        onWithdraw: () => void doOp("withdraw", skill.id, targetId),
                                        onOpen: () => setDrawerId(skill.id),
                                      }, skill.id);
                                    }),
                                  }),
                                ],
                              }, group.key)),
                      ],
                    }),
                    drawerSkill !== null
                      ? jsx(DetailDrawer, {
                          skill: drawerSkill,
                          state,
                          busy,
                          closing: drawerClosing,
                          onClose: closeDrawer,
                          t,
                          onDeploy: (tid) => void doOp("deploy", drawerSkill.id, tid),
                          onWithdraw: (tid) => void doOp("withdraw", drawerSkill.id, tid),
                          onReveal: (path) => void doReveal(path),
                        })
                      : null,
                    selectedTarget !== null
                      ? jsxs("div", {
                          className: "yng-batchbar",
                          children: [
                            jsx("span", { className: "yng-batchlabel", children: fmt(t("batch.scope"), { count: visibleSkills.length, target: selectedTarget.name }) }),
                            jsxs("div", {
                              className: "yng-batchbuttons",
                              children: [
                                jsx("button", { type: "button", className: "yng-btn primary lg", disabled: busy || visibleSkills.length === 0, onClick: () => openBatchConfirm("deploy"), children: t("batch.applyAll") }),
                                jsx("button", { type: "button", className: "yng-btn secondary lg", disabled: busy || visibleSkills.length === 0, onClick: () => openBatchConfirm("withdraw"), children: t("batch.withdrawAll") }),
                              ],
                            }),
                          ],
                        })
                      : null,
                  ],
                }),
          settingsOpen && state !== null
            ? jsx(SettingsDrawer, {
                state,
                busy,
                closing: settingsClosing,
                onClose: closeSettings,
                t,
                onAddTarget: () => void doAddTarget(),
                onRemoveTarget: (target) => setConfirmState({ kind: "removeTarget", targetId: target.id, targetName: target.name, targetPath: target.path }),
                onRenameTag: (oldName, newName) => void doSettingsOp("renameTag", { oldName, newName }),
                onSetTagColor: (name, colorIndex) => void doSettingsOp("setTagColor", { tag: name, colorIndex }),
                onDeleteTag: (name) => void doSettingsOp("deleteTag", { tag: name }),
                onReorderTags: (tags) => void doSettingsOp("reorderTags", { tags }),
                onCreateTag: (name) => void doSettingsOp("createTag", { tag: name }),
                onReveal: (path) => void doReveal(path),
              })
            : null,
          confirmView !== null
            ? jsx(ConfirmModal, {
                title: confirmView.title,
                hint: confirmView.hint,
                listText: confirmView.listText,
                confirmLabel: confirmView.confirmLabel,
                danger: confirmView.danger,
                busy,
                onConfirm: () => void runConfirmed(),
                onCancel: () => setConfirmState(null),
                t,
              })
            : null,
          toast !== null
            ? jsxs("div", {
                className: `yng-toast${toast.exiting ? " exiting" : ""}`,
                role: "status",
                children: [
                  jsx("span", {
                    className: "yng-toast-dot",
                    style: {
                      background:
                        toast.kind === "success"
                          ? "var(--dsw-alias-state-success-primary)"
                          : toast.kind === "warn"
                            ? "var(--dsw-alias-state-warn-primary)"
                            : "var(--dsw-alias-brand-primary)",
                    },
                  }),
                  jsx("span", { children: toast.text }),
                ],
              })
            : null,
        ],
      });
    }

    /* ---------------------------------------------------------------- */
    /* registration                                                       */
    /* ---------------------------------------------------------------- */

    const inject = ["slots", "locale", "uiWorkspace"];

    function apply(ctx) {
      ctx.locale.register(NS, "zh", ZH);
      ctx.locale.register(NS, "en", EN);
      const t = ctx.locale.bind(NS);

      const PanelEntry = (props) => jsx(YingziPanel, { ...props, ctx, t });

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => t("panel") }, PanelIcon),
      );
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, label: () => t("panel") }, PanelEntry),
      );
    }

    return { inject, apply, PanelIcon, YingziPanel, SettingsDrawer };
  },
});
