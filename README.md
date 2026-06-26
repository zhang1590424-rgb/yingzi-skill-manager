# 影子

个人本地 Skill 管理器，用来统一查看和分发全局目录与项目级 Skill。

「影子」表示主库中的 Skill 是实体，应用到全局目录或项目时生成可收回、可覆盖、可验证的影子。

## 当前能力

- 查看 `~/.skills-manager/skills` 中的技能列表。
- 在顶部目标下拉中切换「全部技能」或某个目标，查看目标下的技能状态。
- 默认管理 `~/.agents/skills`，也支持在设置抽屉中手动添加目标目录。
- 手动添加项目后，项目级技能目录固定为 `<项目根>/.agents/skills`。
- 将主库技能通过软链接分发到全局或项目目录。
- 收回指向主库的软链接，不删除主库技能。
- 按目标状态筛选：全部状态、已应用、未应用、有问题。
- 对当前筛选结果执行批量应用或批量收回。
- 通过标签体系筛选、组织和管理技能，支持标签颜色、重命名、删除和排序。
- 导入包含 `SKILL.md` 的本地文件夹，或导入 `.zip` 技能包。
- 在设置抽屉中查看技能根目录，管理目标目录。

## 本地数据位置

```text
~/.skills-manager/
  skills/
  app.db
  config.json
```

主库是唯一事实源。分发到全局目录或项目时，目标目录中创建的是软链接。

## 默认路径

| 范围 | 默认路径 | 是否可扩展 |
|---|---|---|
| 技能主库 | `~/.skills-manager/skills` | 当前仅查看，不在 UI 中改路径 |
| 默认全局目标 | `~/.agents/skills` | 默认存在，不可删除 |
| 手动目标 | `<项目根>/.agents/skills` | 通过设置抽屉添加项目根路径 |

当前设置抽屉用于打开技能根目录、添加或移除目标目录；不提供修改技能主库路径的入口。

## 使用策略

| 项 | 策略 |
|---|---|
| 分发方式 | 软链接 |
| 冲突处理 | 主库优先覆盖 |
| 备份 | 第一版不做 |
| 操作日志 | 第一版不做 |
| 项目发现 | 手动添加项目 |
| 旧目录 | `.codex/skills`、`.trae-cn/skills` 等旧目录不扫描、不迁移、不清理 |

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
影子.app
src-tauri/target/release/bundle/macos/影子.app
```

## 验证记录

最近一次验证状态：

- 2026-06-26 执行 `npm run tauri:build:test-dmg`，通过。
- 前端 `tsc -b && vite build` 通过。
- Rust release 构建通过。
- macOS 应用已打包到 `src-tauri/target/release/bundle/macos/影子.app`。
- 根目录快捷产物已同步到 `影子.app`。
- GitHub Release 用 DMG 已准备到 `release/yingzi_0.1.0-test.1_arm64.dmg`。
- 已执行 `open -n "影子.app"` 触发本地启动。
- 仍需人工走查：1040×680 到 1440×900 下，顶部目标切换、3 列技能网格、详情抽屉、设置抽屉和底部批量条不溢出。
