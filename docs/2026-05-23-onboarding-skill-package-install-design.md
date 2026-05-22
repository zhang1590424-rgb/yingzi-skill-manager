# 初始化预制 Skill 安装设计

日期：2026-05-23

## 1. 背景

初始化引导已有 Agent 选择、存量 Skill 入库、项目添加三步，但用户仍需要在第一次启动时把随包提供的预制 Skill 放入主库。预制包路径来自本地压缩包，当前为 `/Users/bytedance/Downloads/o3vUSTmq.zip`。

本次目标不是做 Skill 市场，也不是自动分发到 Agent，而是在初始化最后一步把压缩包中的正式 Skill 解压识别出来，让用户按用途勾选导入主库。

## 2. 核心决策

| 决策 | 为什么 | 对用户的影响 |
|---|---|---|
| 初始化引导改为 4 步 | 预制 Skill 安装是独立来源，不能混入 Agent 存量入库 | 用户能区分“本机已有 Skill”和“预制包 Skill” |
| 只扫描 `skills/<name>/SKILL.md` | 压缩包内可能包含插件目录和插件自带 Skill，直接全扫会放大数量 | 用户只看到预制 Skill，不会被插件内部内容干扰 |
| 按用户口径分为 4 类 | 目录名多为英文，直接展示会增加理解成本 | 用户按工作场景选择，不需要先理解每个 Skill 的技术来源 |
| 默认勾选全部预制 Skill | 这是本地预制包，安装只进入主库，不直接改变 Agent 目录 | 用户可快速完成初始化，也能手动取消不需要的项 |
| 重名默认跳过，不覆盖主库 | 主库是唯一事实源，初始化不应静默覆盖已有资产 | 已有 Skill 不会被误替换，界面显示已存在状态 |
| 允许跳过 | 初始化不应阻塞进入工作台 | 用户可稍后从导入入口处理 |

## 3. 分类

| 分类 | Skill |
|---|---|
| 产品创意 | `brainstorming`、`office-hours`、`plan-ceo-review`、`storyline` |
| 需求编写 | `ug-num-strategy`、`ug-prd-review-jc-style`、`ab-test-setup`、`experiment-ux-guard` |
| UI设计 | `ui-ux-pro-max`、`design-taste-skill-pack`、`impeccable` |
| 其他工具 | `agent-browser`、`find-skills`、`skill-creator` |

## 4. 交互流程

初始化第 4 步标题为「选择预制 Skill」。

界面结构：

- 顶部说明当前压缩包路径和识别到的 Skill 数量。
- 中间按 4 个分类展示勾选列表。
- 每个 Skill 展示名称、简短说明、安装状态。
- 已存在的 Skill 默认禁用勾选并标记「已在主库」。
- 底部提供「跳过」和「导入已勾选（N）」。

默认预制包不存在、损坏或扫描失败时，展示可恢复空状态：

- 显示失败原因。
- 提供「选择压缩包」。
- 保留「跳过」。

## 5. 数据与导入规则

后端提供两个命令：

- `scan_skill_package(packagePath)`：读取压缩包，返回 `skills/<name>/SKILL.md` 对应的 Skill 列表、分类、描述和是否已存在。
- `import_skills_from_package(packagePath, skillIds)`：只导入用户勾选的 Skill 目录，成功后返回最新 `AppState`、变更数、跳过项和错误。

导入规则：

- 技能 ID 取目录名经 `slugify` 后的结果。
- 目标路径为 `~/.skills-manager/skills/<skillId>`。
- 目标已存在则跳过，不覆盖。
- 忽略 `plugins/`、`._*`、`.DS_Store`。
- 导入完成后停留在「技能列表」。

## 6. 验证标准

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- 首次初始化显示 4 步。
- 第 4 步只展示 14 个预制 Skill，不展示 `plugins/superpowers/skills`。
- 分类与本设计一致。
- 勾选部分 Skill 后只导入选中项。
- 已存在 Skill 不被覆盖。
- 跳过后仍可完成初始化。
