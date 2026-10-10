# @local/yingzi-panel — 影子 · 技能库面板

把本地 [影子](https://github.com/) 技能管理器的能力带进 Harness 侧栏：在「插件」入口下方新增「影子」面板，
浏览 `~/.skills-manager/skills` 主库、查看每个技能在各目标的影子（软链接）状态、一键应用 / 收回、按标签筛选、导入新技能；
并完整移植影子的**设置抽屉**（技能根目录 / 目标目录管理 / 标签管理）。

## 它如何复用影子的事实源

| 数据 | 来源 | 读写 |
| --- | --- | --- |
| 技能主库 | `~/.skills-manager/config.json` → `skillsRoot`，实时扫描子目录（含 `SKILL.md`） | 读 |
| 目标列表 | `~/.skills-manager/app.db` `targets` 表 | 读写（设置抽屉可添加 / 移除目标） |
| 标签 | `app.db` `skill_tags` / `tag_meta` | 读写（设置抽屉可新建 / 重命名 / 换色 / 排序 / 删除） |
| 目标技能路径 | 与影子 `compute_skills_path` 一致：以 `.agents/skills` 结尾原样使用，否则追加 | — |
| 状态诊断 | 镜像影子 `analyze_target_path`：enabled / disabled / broken / conflict / pathMissing / unreadable，前端映射为 已应用 / 未应用 / 有问题 | — |
| 应用 / 收回 | 在目标 `.agents/skills` 下创建或移除**目录软链接**；冲突内容默认不动，显式覆盖才替换 | 写 |
| 导入 | 目录含 `SKILL.md` → 复制进主库，`slugify(目录名)` 命名，同名报错；导入即按 frontmatter 初始化标签（含 `tag_initialized` 防复活标记），与影子 U16 语义一致 | 写主库 + 标签库 |

### 与影子后端的逐位一致性

- `add_target` 生成的目标 ID 与影子 `stable_id`（Rust `DefaultHasher` = SipHash-1-3, k0=k1=0）**逐位一致**——已用 rustc 编译参考实现对拍验证（含 CJK 路径）。两个界面添加同一路径得到同一条记录，不会重复。
- 标签 / 目标操作逐条镜像 `storage.rs`：`rename_tag` 的同名拒绝、`remove_target` 的默认目标保护与「受管软链未收回拒绝移除」、`create_tag` 的 sort_order 续排、`reorder_tags` 的批量写序、导入的 `tag_initialized` 防复活。

## 通信与安全

- 浏览器半 ←→ 宿主半走宿主半在 Harness web server（仅回环）上注册的 `POST /yingzi/api`。
- 每次激活生成随机令牌，经 `webserver/index-inject` 注入页面 `window.__YINGZI_TOKEN__`；请求需带 `x-yingzi-token` 头，跨站请求拒绝。
- 所有路径操作做段名校验与越界检查；「打开目录」仅允许主库与已注册目标。
- 配置数据库写入使用独立短事务 + `busy_timeout=3000`，与影子.app 并发打开互不阻塞；状态读取始终只读打开。

## 已知边界

- 需要 **Web GUI**（`dsh web` 的浏览器页面）。Electron file:// 模式下无同源 HTTP，面板会提示令牌缺失。
- 两个界面写同一份 `app.db`：插件写入后，影子.app 需刷新一次才可见（反之亦然）。
- 仅支持目录导入，zip 包导入请用影子.app。
- 已发现影子.app 自身的既有缺陷（与插件无关）：本机 `app.db` 的 `deployments` 表仍是旧 schema（`target_kind/agent_id/project_id`），`ensure_database` 用 `CREATE TABLE IF NOT EXISTS` 不会迁移旧表，导致影子.app 写部署快照报错 `no column named target_id`。插件不写 `deployments`，不受影响。

## 安装 / 卸载

```sh
# 由 agent 执行
plugin_manager install_bundle  target=<本目录的绝对路径>
plugin_manager remove_bundle   target=@local/yingzi-panel
```

安装后若面板未出现或提示令牌缺失，刷新一次页面即可（index 需要重新渲染以注入令牌）。
