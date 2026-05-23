# GitHub Release 测试分发设计

日期：2026-05-23

## 1. 背景

当前项目已经可以通过 Tauri 生成 `影子.app`，并在 `npm run tauri:build` 后同步到项目根目录。但这只适合本机查找和打开，不适合给朋友一个链接下载安装。

本次目标是把「影子」做成小范围朋友测试版：项目可以开源，用户通过 GitHub Release 链接下载 macOS 安装包并安装。因为暂时没有 Apple Developer Program、Developer ID 签名和 Apple notarization，本设计不追求“无安全提示打开”，而是追求流程稳定、说明清楚、版本可追踪。

## 2. 事实依据

| 事实 | 来源 | 对本项目的含义 |
|---|---|---|
| DMG 是 macOS App Store 外常见的安装分发格式，Tauri 可通过 `tauri build -- --bundles dmg` 生成 | Tauri DMG 文档：https://v2.tauri.app/distribute/dmg/ | 测试包应优先使用 `.dmg`，而不是直接发送 `.app` |
| GitHub Release 可以附带二进制资产，供其他人下载使用 | GitHub Releases 文档：https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases | `.dmg` 应作为 Release asset 上传，不进入源码目录 |
| GitHub Release 单个 release 最多 1000 个 asset，单个文件小于 2 GiB，且没有总大小和带宽限制 | GitHub Releases 文档：https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases | 小型 Tauri DMG 足够放在 Release 中分发 |
| macOS 外部分发想获得默认 Gatekeeper 下的顺滑体验，需要 Developer ID 签名和公证 | Apple Developer ID 文档：https://developer.apple.com/support/developer-id/ | 未公证测试版必须给测试者明确打开说明 |

## 3. 目标与非目标

目标：

- 生成朋友可下载的 macOS `.dmg` 测试包。
- 通过公开 GitHub 仓库和 GitHub Release 提供下载链接。
- Release 页面明确标记为测试版，并说明未公证导致的首次打开方式。
- 构建产物可追踪到 Git tag 和本地版本。
- 保持源码仓库干净，不提交 `.dmg`、`.app` 等生成产物。

非目标：

- 不做 Apple Developer ID 签名。
- 不做 Apple notarization。
- 不做 Mac App Store 上架。
- 不做自动更新。
- 不做 Windows、Linux 分发。
- 第一版不强制做 universal 包；默认支持 Apple Silicon Mac。

## 4. 核心决策

| 决策 | 为什么 | 对用户的影响 |
|---|---|---|
| 使用 GitHub Releases 分发 | 项目可以开源，Release 比网盘更适合版本管理和公开下载 | 朋友拿到的是稳定 Release 链接，而不是临时文件分享 |
| 安装包格式使用 `.dmg` | Mac 用户熟悉“打开 DMG，拖到 Applications”的安装方式 | 安装步骤接近普通 Mac 软件 |
| 使用 ad-hoc 签名 | Apple Silicon 上应用仍需要基本代码签名；`-` 签名不需要 Apple Developer Program | 降低“应用已损坏”类提示概率，但不会消除 Gatekeeper 的未公证提醒 |
| Release 标记为 pre-release | 当前没有签名公证，仍是测试版 | 测试者预期更准确，不会误以为是正式稳定版 |
| `.dmg` 作为 Release asset，不进入 Git | 二进制产物不适合进源码历史 | 仓库克隆更轻，版本历史更干净 |
| 第一版默认 `arm64` | 朋友测试优先覆盖现代 Apple Silicon Mac，降低构建复杂度 | Intel Mac 用户暂时不能使用，后续可补 universal |
| 附带安装说明 | 未公证应用首次打开会被 macOS 提醒 | 测试者知道如何继续打开，减少来回解释 |

## 5. 发布流程

整体流程：

```text
本地完成代码验证
  ↓
构建 arm64 DMG 测试包
  ↓
把产物整理到 release/
  ↓
确认 Git 工作区干净
  ↓
创建并推送公开 GitHub 仓库
  ↓
创建测试 tag，例如 v0.1.0-test.1
  ↓
创建 GitHub pre-release
  ↓
上传 DMG 和安装说明
  ↓
把 Release 链接发给朋友
```

朋友安装流程：

```text
打开 GitHub Release 链接
  ↓
下载 影子_<version>_arm64.dmg
  ↓
双击打开 DMG
  ↓
把「影子」拖到 Applications
  ↓
首次打开如果被 macOS 拦截：
右键「打开」，或到 系统设置 → 隐私与安全性 → 仍要打开
```

## 6. 产物规则

| 产物 | 路径 | 是否提交 Git | 用途 |
|---|---|---|---|
| `影子.app` | 项目根目录 | 否 | 本机快速打开检查 |
| `影子_<version>_arm64.dmg` | `release/` | 否 | 上传到 GitHub Release |
| `影子_安装说明.md` | `release/` | 否 | 上传到 GitHub Release，或复制进 Release Notes |

版本命名：

- tag 使用 `v<version>-test.<n>`，例如 `v0.1.0-test.1`。
- DMG 文件名使用 `影子_<version>_arm64.dmg`，例如 `影子_0.1.0-test.1_arm64.dmg`。
- Release 标题使用 `影子 0.1.0 测试版 1`。

## 7. Release 文案

Release Notes 必须包含：

- 这是小范围测试版，不是正式稳定版。
- 当前只支持 Apple Silicon Mac。
- 当前未做 Apple Developer ID 签名和公证。
- 首次打开如果被 macOS 拦截，可右键「打开」，或到「系统设置 → 隐私与安全性」允许。
- 测试反馈建议包含：macOS 版本、Mac 芯片类型、是否能打开、导入和分发 Skill 是否正常。

示例结构：

```markdown
## 下载

- Apple Silicon Mac：下载 `影子_<version>_arm64.dmg`

## 安装

打开 DMG 后，把「影子」拖到 Applications。

## 首次打开提示

这是未公证测试版。如果 macOS 阻止打开，请右键点击「影子」并选择「打开」，或到「系统设置 → 隐私与安全性」允许打开。

## 反馈

请反馈 macOS 版本、芯片类型、是否能启动、核心功能是否正常。
```

## 8. 错误与风险处理

| 风险 | 处理 |
|---|---|
| 用户下载源码包而不是 DMG | Release Notes 第一屏明确写“下载 Assets 中的 `.dmg`” |
| 用户是 Intel Mac | Release Notes 明确写“仅 Apple Silicon”；后续补 universal 包 |
| macOS 阻止打开 | 安装说明写清右键打开和系统设置允许 |
| GitHub 仓库尚未创建 | 发布脚本或手动流程先检查 `git remote -v` |
| Git 工作区有未提交修改 | 创建 tag 前必须停止发布，要求先提交或放弃无关改动 |
| DMG 产物找不到 | 构建整理脚本给出明确错误，不静默跳过 |

## 9. 验证标准

实现后每次发布测试包前必须验证：

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run tauri:build`
- DMG 构建命令成功生成 `.dmg`
- `release/` 中存在命名正确的 DMG 和安装说明
- 本机可以打开 `影子.app`
- 从 DMG 拖到 Applications 后可以启动
- Release 页面能看到 `.dmg` asset
- 复制 Release 链接后，在未登录 GitHub 的浏览器窗口中可以访问公开下载页

## 10. 后续升级

当朋友测试稳定后，再进入正式分发阶段：

- 注册 Apple Developer Program。
- 配置 Developer ID Application 证书。
- 配置 Tauri macOS 签名。
- 配置 Apple notarization。
- 增加 universal 架构或分别发布 `arm64`、`x64` 包。
- 评估 Tauri updater，支持应用内更新提示。
