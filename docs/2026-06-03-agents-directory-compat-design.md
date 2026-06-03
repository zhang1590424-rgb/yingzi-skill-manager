# `.agents/` 目录兼容设计

## 1. 背景

部分本地 Agent 或项目会使用 `.agents/` 作为根目录承载技能能力。影子当前默认只识别 `.trae-cn/skills`、`.codex/skills`、`.claude/skills`、`.aiden/skills`，导致这类目录不能直接进入默认 Agent 管理范围。

## 2. 设计决策

| 决策 | 说明 | 对用户的影响 |
| --- | --- | --- |
| 把 `.agents/skills` 作为新增默认 Agent 目录 | 不改变现有按 Agent 分发模型，只扩展一个 Agent 根目录 | 用户能在「我的 Agent」里看到 `Agents` |
| 全局路径使用 `~/.agents/skills` | 与其他默认 Agent 的全局 Skill 目录保持一致 | 可直接管理全局 Agents 技能目录 |
| 项目路径使用 `<项目根>/.agents/skills` | 从 Agent 根目录 `.agents` 推断项目级目录 | 应用到项目时会写入项目根目录下的 `.agents/skills` |
| 不自动创建 `.agents/` 根目录 | 只在用户执行分发时按现有逻辑创建需要的 `skills` 目录 | 未使用时不会主动污染项目或用户主目录 |

## 3. 行为约定

- 初始化检测默认 Agent 时新增 `Agents`。
- 如果 `~/.agents` 或 `~/.agents/skills` 存在，初始化页默认勾选 `Agents`；否则显示未找到，可稍后在设置页启用。
- 项目候选扫描把 `.agents/skills` 计为项目级 Skill 目录，把 `.agents` 计为 Agent 工作痕迹。
- 设置页手动添加 `~/.agents/skills` 时，沿用现有推断规则：Agent id 为 `agents`，显示名为 `Agents`，项目目录规则为 `.agents/skills`。

## 4. 验收标准

- 设置页能展示 `Agents` 默认 Agent。
- 对项目分发 Skill 时，目标路径为 `<项目根>/.agents/skills/<skill-id>`。
- 包含 `.agents/skills` 的项目能被初始化项目推荐识别。
- `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`、`npm run tauri:build` 通过。
