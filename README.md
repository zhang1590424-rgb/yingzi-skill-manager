# 技能中枢

个人本地 Skill 管理器，用来统一查看和分发 Trae CN、Codex、Claude Code、Aiden 的全局与项目级 Skill。

## 当前能力

- 查看 `~/.skills-manager/skills` 中的技能列表。
- 查看 Trae CN、Codex、Claude Code、Aiden 的全局技能状态。
- 手动添加项目，并查看项目级技能状态。
- 将主库技能通过软链接分发到全局或项目目录。
- 收回指向主库的软链接，不删除主库技能。
- 发现未入库技能后，可以单个入库或按当前范围批量导入。
- 创建、编辑、应用、收回技能组合。
- 配置默认智能体应用的全局技能目录。

## 本地数据位置

```text
~/.skills-manager/
  skills/
  app.db
  config.json
```

主库是唯一事实源。分发到 Agent 或项目时，目标目录中创建的是软链接。

## 默认 Agent 路径

| Agent | 全局路径 | 项目级相对路径 |
|---|---|---|
| Trae CN | `~/.trae-cn/skills` | `.trae-cn/skills` |
| Codex | `~/.codex/skills` | `.codex/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Aiden | `~/.aiden/skills` | `.aiden/skills` |

路径可以在应用的「设置」页修改。

## 使用策略

| 项 | 策略 |
|---|---|
| 分发方式 | 软链接 |
| 冲突处理 | 主库优先覆盖 |
| 备份 | 第一版不做 |
| 操作日志 | 第一版不做 |
| 项目发现 | 手动添加项目 |

## 开发命令

```bash
npm install
npm run build
npm run tauri:build
```

本地预览：

```bash
npm run dev -- --host 127.0.0.1
```

打包后的 macOS 应用位置：

```text
src-tauri/target/release/bundle/macos/技能中枢.app
```

## 验证记录

已验证：

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run tauri:build`
- macOS 可启动打包后的 `技能中枢.app`
- 1280×820 与 1040×680 预览截图下，三栏布局没有明显重叠或按钮溢出
