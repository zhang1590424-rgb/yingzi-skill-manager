# 初始化引导改造 plan（v2：环境兼容优先）

## 背景

第一版方案做了三步 onboarding 屏，目的是让用户首启不慌。但实际跑起来发现：

1. 横向 SetupGuide 已确认丢弃。
2. 真正让用户难受的不是没有引导，而是**首启就一连串报错**：升级后 schema 不匹配、Agent 目录读不动、目标目录里一堆遗留 Skill 全标成"未入库 / conflict"，用户进来一看就是几十个红色提示。
3. 用户希望：**我们替他兜住环境差异，让首屏看起来是干净的；冲突和遗留物用户自己也搞不清，不要让他自己处理**。

所以本版计划聚焦两件事：

- **环境枚举与兼容**：把真实可能遇到的环境差异列出来，每一种都给出兜底，不让首启崩。
- **首屏静音**：默认不展示遗留物报错，只在 onboarding 里温和提一次"我帮你接管这些散落的 Skill"。

横向 SetupGuide 和"右下角设置卡片"全部不要。

## 用户环境枚举

按照 `Store::new` → `ensure_database` → `load_app_state` → 前端首屏 这条路径，把可能踩到的差异分组列出来。

### A. 主库与配置文件

| 情况 | 现状 | 问题 |
| --- | --- | --- |
| `~/.skills-manager` 不存在 | `fs::create_dir_all` 创建 | OK |
| `~/.skills-manager/skills` 已存在但是个文件 | `create_dir_all` 报错 "无法创建技能主库目录" | 罕见，保持报错可以，但首屏要展示成可恢复 UI |
| `dirs::home_dir()` 取不到 | 直接 anyhow | 罕见，保持原状 |
| 旧版 `app.db` 已经存在，schema 缺 `enabled` 列 | `CREATE TABLE IF NOT EXISTS` 不会改表，`SELECT enabled FROM agents` 直接报错 | **首启就崩，必须修** |
| 旧版 `app.db` 缺 `settings` 表 | `IF NOT EXISTS` 会建，OK | OK |

### B. 默认 Agent 全局目录（`~/.trae/skills` 等）

| 情况 | 现状 | 问题 |
| --- | --- | --- |
| 三个目录都不存在 | 已按 `exists` 决定 enabled | OK |
| 只有部分存在 | enabled 决策正确 | OK |
| 存在但是符号链接指向其他目录 | `exists()` true，正常读 | OK |
| 存在但是文件不是目录 | `fs::read_dir` 抛错 → `load_app_state` 整体崩 | **必须兜底**，转成 workspace 级 issue，不阻塞 |
| 存在但无读权限 | 同上 | **同样要兜底** |

### C. 默认 Agent 目录里的内容

| 情况 | 现状 | 问题 |
| --- | --- | --- |
| 干净空目录 | 没有 status，OK | OK |
| 里面有 SKILL.md 子目录（用户以前手放的） | 标记 `unmanaged`，进入 issue 列表 | 首启刺眼，需要 onboarding 一键接管 |
| 里面有指向主库以外的软链 | 标记 `conflict` | 首启刺眼。第一版**不要**自动处理，但首屏不要爆出来 |
| 里面有 dangling symlink | 标记 `broken` | 首启刺眼。第一版不自动处理，但首屏不要爆出来 |
| 里面有 `.DS_Store`、README、非 SKILL 子目录 | 已 `is_skill_like` 过滤 | OK |

### D. 主库现有 Skill

| 情况 | 现状 | 问题 |
| --- | --- | --- |
| 主库里有目录但没 SKILL.md | issue_count=1，列表里能看到 | OK，留给用户处理 |
| 主库目录读取失败（权限） | `fs::read_dir` 抛错 | **必须兜底**，让 App 仍能开起来 |

## 改造目标

1. **首启不崩**：以上每一种环境差异要么自动处理，要么转成局部可恢复信息，**不让 `get_app_state` 整个失败**。
2. **首屏静音**：未入库 / conflict / broken 这些遗留物不在首屏顶部炸出来，而是聚到 onboarding 第二步"我替你接管"。
3. **onboarding 三步极简**：选 Agent → 一键接管未入库的 Skill → 可选添加项目。Conflict / broken **不在引导里处理**，引导里只提示"另外发现 N 个冲突 / 失效，稍后到主页处理"。
4. **设置页可重开引导 + 改 Agent 启用**。

## 当前状态分析

代码层面已经完成的部分（来自 v1 实施）：

- `src-tauri/src/models.rs`：`OnboardingStatus` / `DetectedAgent` / `BulkAdoptItem` / `BulkAdoptReport` 已加。
- `src-tauri/src/storage.rs`：`default_agent_definitions` 已根据 `exists` 决定 `enabled`；`detect_default_agents`、`set_agent_enabled`、`onboarding_status`、`set_onboarding_completed`、`list_unmanaged_in_enabled_agents` 已加。
- `src-tauri/src/commands.rs`：`get_onboarding_status`、`detect_default_agents`、`set_agent_enabled`、`set_onboarding_completed`、`list_unmanaged_for_onboarding`、`bulk_adopt_skills` 已加。
- `src-tauri/src/lib.rs`：6 个新命令已注册。
- `src/types.ts` / `src/api.ts`：类型与 API 已加。
- `src/App.tsx`：横向 SetupGuide 已删除；`OnboardingScreen` 三步已写完，并按 `onboardingCompleted` 状态在主屏前显示。

但**尚未做**的、本版要补的核心兼容工作：

- `ensure_database` 没有迁移 `agents.enabled` 列。
- `scan_target_root` 的 `fs::read_dir` 失败会让 `load_app_state` 整体崩。
- `scan_library_skills` 的 `fs::read_dir` 失败也会整体崩。
- 首屏顶部 issues 区把 unmanaged 显著展示，会让首启感觉到一堆"未入库"红字（取决于历史目录内容）。
- SettingsPanel 没有"重新打开引导"按钮和 Agent 启用开关。
- onboarding screen 的样式还没写。

## 拟改动

### 1. 后端：schema 迁移（必须）

文件：[storage.rs](file:///Users/bytedance/项目/skill管理器/src-tauri/src/storage.rs)

在 `ensure_database` 里 `CREATE TABLE` 之后，新增轻量迁移：

- 用 `PRAGMA table_info(agents)` 读取列名集合。
- 如果不包含 `enabled`，执行 `ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`，然后再按当前默认 Agent 的 `exists` 把 `enabled` 回填一次（仅在迁移那次）。
- 后续如果还要加列，按同样方式加 if-missing 分支。第一版只补 `enabled`。

为什么：旧 db 不迁移，`load_agents` 读 `enabled` 直接挂，整个 App 起不来。

### 2. 后端：扫描兜底，不让 `load_app_state` 崩

文件：[storage.rs](file:///Users/bytedance/项目/skill管理器/src-tauri/src/storage.rs)

- `scan_library_skills`：把 `fs::read_dir(&self.skills_root)` 的错误**吞掉**，返回空列表，并在返回值里**通过日志 + 在 `AppState.issues` 里加一条字符串**提醒。具体做法：把方法签名保留 `Result`，但在 `load_app_state` 里 catch 后用 `vec![]` 兜底，并把错误文字推入 `issues`。
- `scan_target_root`：把 root 存在但 `fs::read_dir(root)` 失败的情况兜住——保留 root_exists=true 的现有 statuses，仅给 workspace 增加一条形式上的 status，issue 写"无法读取目录"，不要让外层 `?` 直接传播。具体做法：把 `for entry in fs::read_dir(root)…?` 改成 `match fs::read_dir(root)`，错误分支写一条占位 status 并 continue。
- `load_app_state`：所有 workspace 扫描放在 `match` 里，遇到错误把这一个 workspace 的 statuses 设为空，并把错误信息追加到 `AppState.issues`。其他 workspace 继续。

为什么：让用户即便目录权限坏掉、有奇怪文件类型，也能进入主屏，UI 仍可用，只是该 workspace 显示一条"读取失败"的提示。

### 3. 后端：首屏 issues 文案的过滤

文件：[storage.rs](file:///Users/bytedance/项目/skill管理器/src-tauri/src/storage.rs)（`load_app_state` 末尾的 `issues` 收集）

- onboarding 未完成时，前端不展示 `issues`（已经通过提前 return `<OnboardingScreen>` 实现）。
- onboarding 完成后照旧。
- 不在后端做剪裁，保持数据完整性，仅前端首启不渲染。

### 4. 后端：扩展 `list_unmanaged_for_onboarding` 的安全性

文件：[storage.rs](file:///Users/bytedance/项目/skill管理器/src-tauri/src/storage.rs)（`list_unmanaged_in_enabled_agents`）

- 内部使用 `scan_target_root`，复用上面的兜底，所以 read_dir 失败时这里返回空，不报错。
- 不再额外改实现。

### 5. 前端：onboarding 页面在 schema 迁移失败时的兜底

文件：[App.tsx](file:///Users/bytedance/项目/skill管理器/src/App.tsx)

- 现在 `useEffect` 里把 `getOnboardingStatus` 单独 catch 已经做到了。再加一个安全网：如果 `getAppState()` 抛错，仍然显示 `OnboardingScreen`（如果 onboarding 未完成）或主屏的全局错误页（已有），而不是空白。
- onboarding 第二步如果 `listUnmanagedForOnboarding()` 抛错，显示 "暂时无法扫描，可以先跳过这一步" 而不是阻塞整个引导。

### 6. 前端：SettingsPanel 增量

文件：[App.tsx](file:///Users/bytedance/项目/skill管理器/src/App.tsx)（`SettingsPanel` / `AgentSettingRow`）

- 顶部加一行"重新打开初始化引导"按钮：调用 `setOnboardingCompleted(false)`，然后让上层把 `onboardingCompletedState` 设回 false（通过新增 prop `onReopenOnboarding`）。
- Agent 行右侧加一个"启用"开关（复选框或 switch 文案皆可，沿用现有按钮风格），调用 `setAgentEnabled`。已禁用的 Agent 在主屏不出现 workspace。

### 7. 前端：onboarding 样式

文件：[styles.css](file:///Users/bytedance/项目/skill管理器/src/styles.css)

- 加 `.onboarding-shell`、`.onboarding-card`、`.onboarding-step`、`.onboarding-list`、`.onboarding-row`、`.onboarding-footer`、`.onboarding-actions`、`.onboarding-empty`、`.onboarding-header`、`.onboarding-desc` 等。视觉风格：对齐现有 Codex 工作台的内联面板，不引入新色板。

## 假设与决策

- **不做自动清理 conflict / broken**：用户在 onboarding 里只能选择 adopt 未入库的 Skill。剩下两类提示"稍后在主页查看"。这一版不做覆盖前备份，不做自动改写软链接。
- **不做用户主目录的整体备份**：打不动 `app.db` 的极端情况（损坏）暂不处理。
- **schema 迁移用 ALTER TABLE 单列方式**，不引入迁移版本表，第一版够用。
- **首屏 issues 区不再是首启时的入口**：在 onboarding 完成前完全不渲染主屏。
- **OnboardingScreen 已有的代码保留，只补样式 + 错误兜底**，不重构布局。

## 验证

1. 后端单元行为：`cargo check --manifest-path src-tauri/Cargo.toml`。
2. 前端构建：`npm run build`。
3. 模拟环境验证：
   - **新机器**：删 `~/.skills-manager`，启动后看到 onboarding 三步，能完成进入主屏。
   - **老 schema**：手工把现有 `~/.skills-manager/app.db` 备份一份，用 `sqlite3` 删除 `enabled` 列模拟老库（`CREATE TABLE` + `INSERT SELECT` 重建无 enabled 列），重新启动，应自动迁移、不报错。
   - **目标目录里有遗留**：在 `~/.codex/skills` 放一个含 SKILL.md 的子目录，启动 → onboarding 第二步默认勾选并能 bulk adopt 成功。
   - **目标目录权限坏**：`chmod 000 ~/.codex/skills` 后启动，应用应当能开，主屏对该 workspace 显示"读取失败"，不整体崩；恢复权限后刷新即可。
4. UI：在常见尺寸下 onboarding 不溢出、不重叠。
5. 设置页：点"重新打开引导"能回到 onboarding；切换 Agent 启用后主屏 workspace 出现/消失。
