# 影子项目规则

## 项目定位

本项目用于开发一个个人本地的可视化 Skill 管理器，产品中文名为「影子」。

「影子」的产品隐喻是：主库中的 Skill 是实体，应用到全局目录或项目时生成可收回、可覆盖、可验证的影子。

核心目标：

- 统一管理本地 Skill 主库（技能视角）。
- 查看目标（全局目录和项目）的 Skill 分发状态（目标视角）。
- 通过软链接把 Skill 分发到目标。

## 信息架构（v2）

```text
影子 v2
├── 技能视角（默认）
│   ├── 搜索 + 标签筛选（含标签管理）
│   ├── 3 列网格卡片全览
│   └── 选中 → 右侧详情抽屉（340px，网格不变形）
├── 目标视角
│   ├── 目标列表（全局目录 + 项目，统一为 Target）
│   └── 选中目标 → 右侧 Skill 状态列表（行内应用/收回）
└── 设置（右侧抽屉，从顶栏齿轮触发）
    ├── 全局目录管理
    ├── 我的项目
    └── 技能根目录
```

核心概念只有两个：

- **技能**（我有什么）— 主库中的 Skill，带标签和颜色
- **目标**（要放到哪）— 全局目录或项目，统一数据模型 `Target`

## 数据模型概要

| 概念 | 后端结构体 | 说明 |
|------|-----------|------|
| 目标 | `Target` | id / name / path / is_default / path_exists |
| 技能 | `Skill` | id / name / description / tags / path |
| 目标状态 | `TargetStatus` | skill_name / target_id / status / target_path / link_target |
| 工作区 | `TargetWorkspace` | target_id / skills_path / root_exists / statuses |
| 标签 | `TagInfo` | name / color_index / count / sort_order |
| 部署目标 | `DeployTarget` | target_id（统一标识） |

不再有 `Agent`、`Project`、`TargetKind` 分离概念。所有目标统一为 `Target`，通过 `is_default` 区分默认全局目录。

## 命令接口（Tauri commands）

```text
状态：get_app_state
技能：import_skill, delete_skill, deploy_skill, withdraw_skill, set_skill_tags
目标：add_target, remove_target
标签：get_all_tags, get_all_tags_info, rename_tag, set_tag_color, delete_tag, reorder_tag
包导入：scan_skill_package, import_skills_from_package
系统：open_path
```

## 工作原则

- 默认中文沟通，代码、命令、变量名使用英文。
- 产品决策先说明「为什么」和「对用户的影响」。
- 修改行为前先更新规则和设计文档，再进入实现。
- 不为跑通而绕过错误，优先定位根因。
- 密钥、token、密码不得进入代码或文档示例。

## 目录约定

```text
.
├── AGENTS.md          # 本文件，项目规则与上下文
├── DESIGN.md          # 视觉与交互设计约束
├── docs/              # 原型 mockup（HTML）
├── scripts/           # 构建和发布脚本
├── src/               # 前端 React + TypeScript（单文件 App.tsx + api.ts + types.ts + styles.css）
├── src-tauri/         # Tauri 2 / Rust 后端
│   └── src/
│       ├── commands.rs  # Tauri 命令入口
│       ├── models.rs    # 数据结构定义
│       ├── storage.rs   # SQLite 存储 + 文件系统操作
│       └── lib.rs       # 命令注册
└── public/            # 静态资源
```

个人 Skill 资产不放在项目源码目录里，统一放在 `~/.skills-manager/skills`。

## 设计约束

- 产品形态：本地桌面应用。
- 技术方向：Tauri 2 + React + TypeScript + SQLite。
- UI 风格：Premium Utilitarian Minimalism — 暖色单色系 + 编辑式排版 + ultra-flat + 淡彩语义点缀。
- 不做营销首页，不做通用 marketplace 浏览，不做装饰型 AI 风格。
- 导入技能支持本地文件夹和 `.zip` 压缩包。
- 左侧导航只有：技能 / 目标；设置从顶栏齿轮图标触发，以右侧抽屉形式呈现。
- 技能视角默认为 3 列网格卡片全览，选中某个 Skill 后右侧滑入详情抽屉，网格保持 3 列不变形。
- 目标视角为中间目标列表 + 右侧 Skill 状态列表，行内操作。
- 动效要隐形——存在但不抢注意力：staggered fadeInUp、panel slide-in。
- 只动画 `transform` 和 `opacity`，尊重 `prefers-reduced-motion`。
- 避免卡片堆叠、紫色渐变、玻璃拟态、发光边框、深色阴影。

## Skill 管理规则

- 主库默认路径：`~/.skills-manager/skills`。
- 全局目录：默认只管理 `~/.agents/skills`；高级用户可在设置抽屉手动添加其他目标。
- 项目目录：固定落在 `<项目根>/.agents/skills`（通过 `compute_skills_path` 计算）。
- 所有正式 Skill 以主库为唯一事实源。
- 导入本地 Skill 时，必须先进入主库，不直接分发到目标。
- 分发方式：软链接。
- 冲突策略：主库优先覆盖目标同名 Skill。
- 状态只有 3 种：已应用 / 未应用 / 有问题。
- 不做覆盖前备份，不做操作日志。
- 项目级管理只支持手动添加项目路径，不自动扫描项目。
- 标签支持自定义颜色（16 色预设调色盘）、重命名、排序和删除。
- 标签体系是组织和筛选 Skill 的唯一分组方式，不再保留技能组合 / Preset。
- 不兼容早期历史数据库，不保留 `agents` / `projects` / `presets` 等旧表迁移逻辑。

## 不做什么

- 不做 Agent 多实例管理（已消除，统一为 Target）。
- 不做 Global/Project 双类型分离（统一 Target）。
- 不做 7 种细分状态（合并为 3 种）。
- 不做复杂 onboarding 流程。
- 不做技能组合 / Preset（已由标签体系替代）。
- 不做目标未入库 Skill 的接管、忽略问题和批量修复入口。
- 不做市场链接安装。
- 不用 Inter/Roboto/Open Sans。
- 不用渐变、发光、玻璃拟态。

## 验证规则

每次实现后必须主动验证：

- 能否启动桌面应用。
- 技能视角网格全览 → 选中详情抽屉 → 关闭回网格，流程顺畅。
- 目标视角选中目标 → 行内应用/收回 → 状态即时更新。
- 搜索和标签筛选响应即时。
- 标签管理（颜色、重命名、删除、排序）正常工作。
- 设置抽屉打开/关闭，添加/移除目标正常。
- 窗口 1040x680 ~ 1440x900 下布局不溢出。
- **每次代码改动完成后必须执行 `npm run tauri:build` 重新打包**，产物同步到根目录 `影子.app`，否则用户无法验证。

常用命令：

```bash
npm run build                # 仅前端构建
cargo check --manifest-path src-tauri/Cargo.toml  # Rust 类型检查
npm run tauri:build          # 完整打包（app + 复制到根目录）
npm run tauri:build:test-dmg # 打包 + 生成 DMG + release 目录
```

打包产物：

```text
影子.app                     # 根目录快捷产物（不进版本管理）
release/yingzi_*.dmg         # GitHub Release 用 DMG
```

说明：

- Tauri 原始产物仍在 `src-tauri/target/release/bundle/macos/影子.app`。
- `npm run tauri:build` 完成后必须把桌面应用同步到项目根目录的 `影子.app`，方便直接查找和打开。
- 根目录的 `影子.app` 是生成产物，不进入版本管理。
- GitHub Release 使用 `v0.1.0-test.1` 标签，资产名 `yingzi_0.1.0-test.1_arm64.dmg`，更新时替换同名资产保持下载链接不变。
