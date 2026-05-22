# 默认 Agent 调整设计

## 1. 背景

默认可管理 Agent 原来是 Trae、Codex、Claude Code。当前本机实际使用场景需要把旧版 Trae 替换为 Trae CN，并新增 Aiden。

本轮不改变 Skill 分发模型，仍然使用主库到目标目录的软链接。

## 2. 设计决策

| 决策 | 为什么 | 对用户的影响 |
|---|---|---|
| 默认 Agent 改为 Trae CN、Codex、Claude Code、Aiden | 默认列表应该对应当前真实使用的 Agent，而不是历史占位 | 首次引导和默认检测直接出现这四个 Agent |
| Trae CN 使用 `~/.trae-cn/skills` | 本机已有该目录，并且其中存在 `SKILL.md` 格式的技能 | 可以直接扫描、入库和分发 Trae CN 技能 |
| Aiden 使用 `~/.aiden/skills` | Aiden 本机根目录存在，但尚未看到全局 `skills` 目录；沿用 Agent 根目录下 `skills` 的统一协议 | Aiden 会被识别为已安装，应用 Skill 时自动创建 `skills` 目录 |
| 旧版 Trae 不再作为默认 Agent | 用户明确要求默认 Trae 改成 Trae CN | 新库不会自动创建 Trae；老库中仍是默认路径的 Trae 配置会被移出管理表，真实文件不删除 |
| 手动添加仍支持 Trae | 删除默认不等于禁止管理 | 如仍需要旧版 Trae，可在设置页选择 `~/.trae/skills` 重新添加 |

## 3. 路径规则

| Agent | 全局路径 | 项目级相对路径 |
|---|---|---|
| Trae CN | `~/.trae-cn/skills` | `.trae-cn/skills` |
| Codex | `~/.codex/skills` | `.codex/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Aiden | `~/.aiden/skills` | `.aiden/skills` |

检测是否安装时，不只看 `skills` 目录是否存在，也看 Agent 根目录是否存在。这样 Aiden 这类已安装但尚未建立 Skill 目录的 Agent 不会被误判为未安装。

## 4. 数据迁移

启动时同步默认 Agent：

1. 新数据库直接写入四个默认 Agent。
2. 旧数据库补齐缺失的 Trae CN 和 Aiden。
3. 首次迁移时，如果旧版 Trae 记录仍是 `~/.trae/skills` 与 `.trae/skills`，视为历史默认记录并移出管理表。
4. 如果用户手动改过 Trae 路径，则不自动删除，避免误删自定义配置。

## 5. 验证

- `detect_default_agents` 返回 Trae CN、Codex、Claude Code、Aiden。
- 首次引导文案不再写死旧的三个 Agent。
- 老数据库能自动出现 Trae CN 和 Aiden。
- Aiden 根目录存在但 `skills` 不存在时，检测结果仍为已检测到。
- 构建与 Rust 检查通过。
