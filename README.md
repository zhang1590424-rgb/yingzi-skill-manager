# 影子

个人本地 Skill 管理器，用来统一查看和分发全局目录与项目级 Skill。

「影子」表示主库中的 Skill 是实体，应用到全局目录或项目时生成可收回、可覆盖、可验证的影子。

## 当前能力

- 查看 `~/.skills-manager/skills` 中的技能列表。
- 查看全局目录的技能状态，默认管理 `~/.agents/skills`，可在设置页手动扩展其他全局目录。
- 手动添加项目，并查看 `<项目根>/.agents/skills` 下的项目级技能状态。
- 将主库技能通过软链接分发到全局或项目目录。
- 收回指向主库的软链接，不删除主库技能。
- 通过标签体系筛选、组织和管理技能。
- 配置全局 Skill 目录。

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
| 全局目录 | `~/.agents/skills` | 可在设置页手动添加其他全局目录 |
| 项目目录 | `<项目根>/.agents/skills` | 固定，不再按 Agent 拆分 |

路径可以在应用的「设置」页修改。

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

已验证：

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run tauri:build`
- macOS 可启动打包后的 `影子.app`
- 1280×820 与 1040×680 预览截图下，三栏布局没有明显重叠或按钮溢出
