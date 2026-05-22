# 技能中枢项目规则

## 项目定位

本项目用于开发一个个人本地的可视化 Skill 管理器，产品中文名暂定为「技能中枢」。

核心目标：

- 统一管理本地 Skill 主库。
- 查看 Trae、Codex、Claude Code 的全局 Skill 应用状态。
- 查看手动添加项目中的项目级 Skill 应用状态。
- 通过软链接把主库 Skill 分发到不同 Agent 和项目。

## 工作原则

- 默认中文沟通，代码、命令、变量名使用英文。
- 产品决策先说明「为什么」和「对用户的影响」。
- 修改行为前先更新规则和设计文档，再进入实现。
- 不为跑通而绕过错误，优先定位根因。
- 密钥、token、密码不得进入代码或文档示例。

## 目录约定

```text
.
  AGENTS.md
  docs/
    YYYY-MM-DD-<主题>-design.md
  scripts/
    项目构建和产物整理脚本
  src/
    前端 React / TypeScript 源码
  src-tauri/
    Tauri / Rust 桌面端与本地文件能力
  public/
    静态资源
```

个人 Skill 资产不放在项目源码目录里，统一放在 `~/.skills-manager/skills`。

## 设计约束

- 产品形态：本地桌面应用。
- 技术方向：Tauri 2 + React + TypeScript + SQLite。
- UI 风格：Codex app 式中文工作台，参考 Impeccable 的产品型设计原则。
- 不做营销首页，不做通用 marketplace 浏览，不做装饰型 AI 风格。
- 允许从公司 Skill 市场详情链接安装到主库，但它只是入库来源，不承担市场搜索、推荐和评价体系。
- 顶部主操作保留「导入技能」，市场链接安装归入导入流程，不单独放在「新建技能」入口。
- 优先使用三栏工作台、列表、分栏、抽屉和内联状态。
- 避免卡片堆叠、紫色渐变、玻璃拟态、发光边框、低对比灰字、无意义动效。

## Skill 管理规则

- 主库默认路径：`~/.skills-manager/skills`。
- 所有正式 Skill 以主库为唯一事实源。
- 从公司 Skill 市场链接安装时，必须先进入主库，不直接分发到具体 Agent 或项目。
- 分发方式：软链接。
- 冲突策略：主库优先覆盖目标同名 Skill。
- 第一版不做覆盖前备份，不做操作日志。
- 项目级管理只支持手动添加项目路径，不自动扫描项目。

## 验证规则

每次实现后必须主动验证：

- 能否启动桌面应用。
- 核心页面能否正常展示。
- Skill 扫描、分发、收回是否符合设计。
- UI 在常见桌面窗口尺寸下不重叠、不溢出。

常用命令：

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build
```

打包产物：

```text
技能中枢.app
```

说明：

- Tauri 原始产物仍在 `src-tauri/target/release/bundle/macos/技能中枢.app`。
- `npm run tauri:build` 完成后必须把桌面应用同步到项目根目录的 `技能中枢.app`，方便直接查找和打开。
- 根目录的 `技能中枢.app` 是生成产物，不进入版本管理。
