# 影子 — 项目规则与技术上下文

> 本文件是 AI 协作的唯一入口文档。修改项目前请先通读此文件。

## 一、项目概述

**产品名**：影子（Yingzi）
**定位**：个人本地的可视化 Skill 管理器桌面应用。
**隐喻**：主库中的 Skill 是实体，通过软链接分发到目标目录时生成"影子"——可收回、可覆盖、可验证。

核心功能：

1. 统一管理本地 Skill 主库（`~/.skills-manager/skills`）。
2. 单页工作台中查看目标目录（全局 / 项目）的 Skill 启用状态。
3. 通过软链接把 Skill 分发（应用 / 收回 / 覆盖）到目标。
4. 通过标签体系组织和筛选 Skill。

## 二、技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 框架 | Tauri 2 | 2.10.0 |
| 前端 | React + TypeScript | React 19.2, TS 5.9 |
| 构建 | Vite | 7.3 |
| 后端 | Rust (edition 2021) | rustc 1.77.2+ |
| 数据库 | SQLite (rusqlite bundled) | 0.31 |
| 对话框 | tauri-plugin-dialog | 2.6.0 |
| Markdown | react-markdown + remark-gfm | 10.1 / 4.0 |

Crate name: `skill-hub`，Tauri app identifier: `local.skill-hub`。

## 三、目录结构

```text
.
├── AGENTS.md              # 本文件：项目规则与 AI 协作上下文
├── DESIGN.md              # 视觉与交互设计约束
├── PRODUCT.md             # 产品约束与决策原则
├── README.md              # 项目简介与使用说明
├── scripts/
│   ├── copy-macos-app.mjs   # 打包后复制 .app 到根目录
│   └── prepare-github-release.mjs  # 生成 DMG + release 目录
├── src/                   # 前端源码
│   ├── App.tsx            # 全部 UI 组件（单文件）
│   ├── api.ts             # Tauri invoke 封装 + mock 数据
│   ├── types.ts           # TypeScript 类型定义
│   ├── styles.css         # 全局样式
│   └── main.tsx           # React 入口
├── src-tauri/             # Rust 后端
│   └── src/
│       ├── lib.rs         # Tauri Builder + 命令注册
│       ├── commands.rs    # 所有 Tauri command 实现
│       ├── models.rs      # 数据结构定义（Serialize/Deserialize）
│       ├── storage.rs     # SQLite + 文件系统操作 + SKILL.md 解析
│       └── main.rs        # 程序入口
├── public/                # 静态资源（app-icon.png）
├── index.html             # Vite HTML 入口
├── package.json           # npm scripts + 前端依赖
└── vite.config.ts         # Vite 配置
```

**运行时数据目录**（不在项目源码中）：

```text
~/.skills-manager/
├── skills/          # Skill 主库（每个子目录是一个 Skill）
├── app.db           # SQLite 数据库
└── config.json      # 配置文件
```

## 四、信息架构（当前实现）

```text
影子
├── 单页技能工作台
│   ├── 顶部工具栏
│   │   ├── 目标下拉（全部技能 / 某个 Target）
│   │   ├── 搜索框
│   │   ├── 导入按钮（+）
│   │   └── 设置按钮（齿轮）
│   ├── 标签筛选栏（全部 / 各标签 / 无标签）
│   ├── 技能网格（3 列卡片，按标签或状态分组）
│   ├── 选中卡片 → 右侧详情抽屉（340px）
│   └── 选择目标后 → 底部 sticky 批量操作栏
├── 设置抽屉（右侧 380px）
│   ├── 技能根目录
│   ├── 目标目录管理
│   └── 标签管理（颜色 / 重命名 / 排序 / 删除 / 新建）
├── 导入弹窗（居中模态）
└── 确认对话框（覆盖 / 批量操作）
```

## 五、核心概念

| 概念 | 说明 |
|------|------|
| **技能（Skill）** | 主库中的一个目录，必须包含 `SKILL.md`。通过目录名作为唯一 ID。 |
| **目标（Target）** | 统一抽象，包含默认全局目录和手动添加的项目路径。通过 `is_default` 区分。 |
| **分发** | 从主库到目标的软链接创建过程。 |
| **状态** | 前端只展示 3 种：已应用 / 未应用 / 有问题。后端 7 种映射到这 3 种。 |
| **标签** | Skill 的唯一分组方式，支持 16 色调色盘、排序、重命名。 |

## 六、数据模型

### 6.1 后端结构体（models.rs）

| 结构体 | 关键字段 | 用途 |
|--------|---------|------|
| `Target` | id, name, path, is_default, path_exists | 目标目录 |
| `Skill` | id, name, display_name, description, path, tags, enabled_count, issue_count, content_preview | 主库技能 |
| `TargetStatus` | id, skill_id, skill_name, display_name, description, target_id, target_name, status, target_path, link_target, issue, root_exists | 某技能在某目标的状态 |
| `TargetWorkspace` | target_id, target_name, target_path, skills_path, target_exists, root_exists, statuses | 一个目标的完整工作区快照 |
| `AppState` | base_dir, skills_root, database_path, config_path, targets, skills, workspaces, issues | 全量应用状态 |
| `DeployTarget` | target_id | 部署目标标识 |
| `OperationReport` | changed, skipped, conflicts, errors | 操作结果报告 |
| `TagInfo` | name, color_index, count, sort_order | 标签元信息 |
| `SkillStatus`（枚举） | Enabled, Disabled, Unmanaged, Conflict, Broken, PathMissing, Invalid | 后端 7 种诊断状态 |
| `PackageSkill` | id, name, display_name, description, category, entry_prefix, exists, item_kind, member_count | 包扫描结果中的单个技能 |
| `SkillPackageScan` | package_path, skills, ignored_plugin_skills | 包扫描结果 |
| `PackageImportReport` | state, changed, skipped, errors | 包导入结果 |

### 6.2 前端类型（types.ts）

前端将后端 7 种状态映射为 3 种展示状态：

```typescript
type SkillStatusV2 = "applied" | "notApplied" | "problem";
// enabled → applied
// disabled → notApplied
// 其余 5 种 → problem
```

### 6.3 数据库 Schema（SQLite）

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deployments (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL, target_path TEXT NOT NULL, link_target TEXT);
CREATE TABLE skill_tags (skill_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (skill_id, tag));
CREATE TABLE tag_meta (tag TEXT PRIMARY KEY, color_index INTEGER NOT NULL DEFAULT -1, sort_order INTEGER NOT NULL DEFAULT 0);
```

默认全局目标 ID 固定为 `"agents"`，名称为 `"全局"`，路径为 `~/.agents/skills`。

## 七、命令接口（Tauri commands）

所有命令通过 `tauri::command` 宏注册，前端使用 `invoke()` 调用。

### 状态

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `get_app_state` | 无 | `AppState` | 获取全量应用状态（技能列表、目标列表、各目标工作区状态） |

### 技能

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `import_skill` | source_path: String | `AppState` | 导入单个文件夹或 .zip |
| `delete_skill` | skill_id: String | `AppState` | 删除主库技能（需先收回所有启用位置） |
| `deploy_skill` | skill_id: String, targets: Vec\<DeployTarget\>, overwrite: bool | `OperationReport` | 应用技能到指定目标 |
| `withdraw_skill` | skill_id: String, targets: Vec\<DeployTarget\> | `OperationReport` | 从目标收回技能 |
| `set_skill_tags` | skill_id: String, tags: Vec\<String\> | `AppState` | 设置技能标签（全量替换） |

### 目标

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `add_target` | path: String | `AppState` | 添加目标目录 |
| `remove_target` | target_id: String | `AppState` | 移除目标（默认目标不可移除） |

### 标签

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `get_all_tags` | 无 | `Vec<String>` | 获取所有使用中的标签名 |
| `get_all_tags_info` | 无 | `Vec<TagInfo>` | 获取标签完整信息（含颜色、计数、排序） |
| `create_tag` | tag: String | `Vec<TagInfo>` | 创建空标签 |
| `rename_tag` | old_name: String, new_name: String | `AppState` | 重命名标签 |
| `set_tag_color` | tag: String, color_index: i32 | `Vec<TagInfo>` | 设置标签颜色 |
| `delete_tag` | tag: String | `AppState` | 删除标签（自动从所有技能解除关联） |
| `reorder_tag` | tag: String, direction: String | `Vec<TagInfo>` | 单步上/下移动 |
| `reorder_tags` | tags: Vec\<String\> | `Vec<TagInfo>` | 批量设置标签排序 |

### 包导入

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `scan_skill_package` | package_path: String | `SkillPackageScan` | 扫描压缩包中的技能列表 |
| `import_skills_from_package` | package_path: String, skill_ids: Vec\<String\> | `PackageImportReport` | 从压缩包按 ID 选择性导入 |

### 系统

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `open_path` | path: String | `()` | 用系统文件管理器打开路径 |

## 八、前端架构

### 8.1 状态管理

- 无第三方状态库，全部使用 React `useState` + `useCallback`。
- 核心状态：`AppState` 从后端 `get_app_state` 获取，存于顶层 `App` 组件。
- 大部分写操作返回新的 `AppState`，前端直接 `setState` 替换。
- `api.ts` 中有 `isTauriRuntime()` 检测，非 Tauri 环境返回 mock 数据（方便浏览器开发调试）。

### 8.2 组件层次

```text
App
└── SkillView（主视图，管理所有筛选/选择状态）
    ├── Toolbar（目标下拉 + 搜索 + 导入/设置按钮 + 标签筛选）
    ├── SkillGrid（卡片网格，按标签或状态分组）
    ├── SkillDrawer（右侧详情抽屉：信息 + 标签编辑 + 目标状态行 + SKILL.md 预览）
    │   └── TagEditor（标签行内编辑 + 自动补全）
    ├── SkillContextMenu（右键菜单：快捷标签管理）
    ├── ImportModal（导入弹窗）
    ├── SettingsDrawer（设置抽屉：根目录 + 目标 + 标签管理）
    ├── ConfirmDialog（确认对话框）
    └── Toast（轻量反馈）
```

### 8.3 关键交互流

| 场景 | 触发 | 流程 |
|------|------|------|
| 全览 | 默认 | 加载 AppState → 3 列卡片按标签分组 |
| 目标上下文 | 选择目标 | 卡片按状态分组，显示状态 badge，hover 出现应用/收回按钮 |
| 应用技能 | 卡片 hover / 详情抽屉行 | invoke deploy_skill → refresh → toast |
| 批量应用 | 底部栏按钮 | 确认弹窗 → 逐个 deploy → refresh → toast |
| 导入 | + 按钮 | 模态 → 系统文件对话框 → import_skill / scanPackage+importFromPackage → 刷新 + 高亮新技能 |
| 删除 | 详情抽屉垃圾桶 | confirm → delete_skill → 退出动画 → setState |

## 九、Skill 文件格式

每个 Skill 必须包含 `SKILL.md`，格式：

```markdown
---
name: 显示名称
description: 简短描述
tags: [标签1, 标签2]
---

# 标题

正文内容（Markdown）
```

- `name` 作为 `display_name`，缺省使用目录名。
- `description` 用于卡片描述，缺省取正文第一个有意义行。
- `tags` 导入时写入数据库 `skill_tags` 表作为初始值。
- 正文去除 telemetry 注释后作为 `content_preview`（截断 4000 字符）。

## 十、Skill 管理规则

- **主库**：`~/.skills-manager/skills`，每个子目录名即 skill_id（通过 slugify 生成）。
- **全局目标**：默认 `~/.agents/skills`，不可移除。
- **项目目标**：落在 `<项目根>/.agents/skills`（`compute_skills_path` 智能判断）。
- **分发方式**：`symlink`（Unix）/ `symlink_dir`（Windows）。
- **冲突策略**：overwrite=true 时主库优先覆盖目标同名内容。
- **删除保护**：技能有启用位置时不允许删除，需先全部收回。
- **导入来源**：本地文件夹（含 SKILL.md）或 .zip 压缩包（支持单技能和多技能包）。
- **ZIP 安全**：检查路径遍历攻击、过滤 `__MACOSX` 和 `.DS_Store`。

## 十一、设计系统摘要

详见 `DESIGN.md`，这里列出关键常量：

- 页面背景：`#FBFBFA`，卡片/面板：`#FFFFFF`，边框：`#EAEAEA`
- 正文：`#2F3437`，辅助：`#787774`，最弱：`#A8A5A0`
- 主交互色：`#111111`
- 标签调色盘：16 色预设（见 `App.tsx` 中 `TAG_PALETTE` 常量）
- 窗口：默认 1280×820，最小 1040×680
- 卡片：`border-radius: 8px`，`padding: 16px`，hover shadow `0 2px 8px rgba(0,0,0,0.04)`
- 动效：staggered fadeInUp（delay 封顶 8×50ms），抽屉 translateX 300ms ease-out

## 十二、工作原则

1. **默认中文沟通**，代码/命令/变量名用英文。
2. **产品决策先说明「为什么」和「对用户的影响」**，不只讲实现。
3. **修改行为前先更新规则和设计文档**，再进入实现。
4. **不为跑通而绕过错误**，优先定位根因。
5. **密钥、token、密码**不得进入代码或文档示例。
6. **不过度工程**：不加未要求的特性、不加不必要的抽象。

## 十三、不做什么

- 不做 Agent/Project 双类型分离（统一 Target）。
- 不在 UI 展示 7 种细分状态（聚合为 3 种）。
- 不做复杂 onboarding 流程。
- 不做技能组合 / Preset（已由标签体系替代）。
- 不做目标未入库 Skill 的接管/修复入口。
- 不做市场/在线安装。
- 不做云同步、多账号。
- 不做覆盖前备份、操作日志。
- 不用渐变、发光、玻璃拟态、Inter/Roboto/Open Sans。

## 十四、构建与验证

### 常用命令

```bash
npm run dev                 # 前端开发服务器 (localhost:1420)
npm run build               # 仅前端构建
cargo check --manifest-path src-tauri/Cargo.toml  # Rust 类型检查
npm run tauri:dev           # 完整开发模式（Rust + 前端 hot reload）
npm run tauri:build         # 完整打包（app + 复制到根目录）
npm run tauri:build:test-dmg # 打包 + 生成 DMG + release 目录
```

### 打包产物

```text
影子.app                     # 根目录快捷产物（不进版本管理）
src-tauri/target/release/bundle/macos/影子.app  # Tauri 原始产物
release/yingzi_*.dmg         # GitHub Release 用 DMG
```

### 验证清单

每次代码改动后必须验证：

- [ ] `npm run tauri:build` 成功，`影子.app` 同步到根目录
- [ ] 启动应用，技能网格正常加载
- [ ] 选中卡片 → 详情抽屉打开/关闭流畅
- [ ] 目标下拉切换 → 卡片状态更新 → 行内应用/收回正常
- [ ] 底部批量操作只作用于筛选结果
- [ ] 搜索和标签筛选即时响应
- [ ] 标签管理（颜色/重命名/删除/排序/新建）正常
- [ ] 设置抽屉：添加/移除目标正常
- [ ] 窗口 1040×680 ~ 1440×900 下布局不溢出

### 发布

- GitHub Release 标签格式：`v0.1.0-test.1`
- DMG 资产名：`yingzi_0.1.0-test.1_arm64.dmg`
- 更新时替换同名资产保持下载链接不变

## 十五、快速上手指南

如果你是第一次接手这个项目：

1. **理解产品**：读 `PRODUCT.md`（产品约束）和本文件第一至五节。
2. **理解设计**：读 `DESIGN.md`（视觉和交互规范）。
3. **理解后端**：从 `src-tauri/src/models.rs`（数据结构）→ `commands.rs`（业务逻辑）→ `storage.rs`（存储和文件系统）。
4. **理解前端**：`src/types.ts`（类型）→ `src/api.ts`（命令调用层）→ `src/App.tsx`（全部 UI）。
5. **跑起来**：`npm install && npm run tauri:dev`。
6. **改完验证**：`npm run tauri:build`，打开根目录 `影子.app` 手动验收。

关键约定：

- 前端是单文件架构（`App.tsx`），所有组件在一个文件中。
- 后端状态通过 `get_app_state` 一次性获取全量，不做增量更新。
- 前端 `api.ts` 对后端返回的 `RawAppState` 做转换（展平 workspace → targetStatuses Map）。
- 数据库只存标签和目标配置，技能列表和状态通过实时扫描文件系统获得。
