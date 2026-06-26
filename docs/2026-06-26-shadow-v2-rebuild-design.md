# 影子 v2 — 产品重构设计

## 背景与动机

影子 v1 在增量迭代中积累了过多概念和交互层级。用户的实际使用频率是每周几次（导入新 Skill + 给新项目配 Skill），但产品暴露了 5 个一级概念（Skill / Agent / Project / Preset / TargetStatus），导致完成一个动作需要在多个入口间跳转。

**核心矛盾：** 用户只需要「我有什么 → 放到哪」两步，但 UI 强制经过 6+ 步。

## 第一性原理

用户的本质需求：

> 我有一堆 Skill 文件。我想让「全局所有项目」或「某个具体项目」能用到其中某些。

从这个需求出发，只需要两个概念：

- **技能**（我有什么）
- **目标**（要放到哪）

其他都是实现细节。

## 核心变更

| 维度 | v1 | v2 | 理由 |
|------|----|----|------|
| 一级概念 | 5 个 | 2 + 1（技能/目标/设置） | 降低认知负担 |
| 导航入口 | 5+ 入口 | 3 个 | 一屏可达 |
| Agent 概念 | 独立实体 | 消除，全局目录就是一个目标 | 已退化为单一 `.agents/skills` |
| 技能组合 | 独立一级入口 | 删除，由标签体系替代 | 避免组合和单技能状态打架 |
| 状态种类 | 7 种 | 3 种（已应用/未应用/有问题） | 用户只关心正常 or 需处理 |
| 技能列表默认态 | 单列列表 | 3 列网格卡片 | 50-100 个 Skill 一眼扫全貌 |
| 新项目配 Skill | 6+ 步 | 5 步 | 不跳页面 |
| 单 Skill 分发 | 4+ 步 | 4 步 | 行内操作 |

## 信息架构

```
影子 v2
├── 技能视角（默认）
│   ├── 搜索
│   ├── 标签筛选
│   ├── 网格全览（未选中状态）
│   └── 列表 + 详情面板（选中状态）
├── 目标视角
│   ├── 目标列表（全局目录 + 项目，平级）
│   └── 选中目标的 Skill 状态列表
└── 设置
    ├── 全局目录管理
    ├── 项目管理
    └── 技能根目录
```

## 技能视角

### 默认态：网格全览

- 主内容区铺成 3 列网格卡片
- 每张卡片：名称 + 描述（2 行截断）+ 状态标签
- 搜索栏即时过滤名称和描述
- 标签筛选条：自动识别 SKILL.md 中的 tags + 手动编辑，一个 Skill 可多标签
- 卡片 hover：`box-shadow: 0 2px 8px rgba(0,0,0,0.04)` + 200ms ease
- 卡片入场：staggered fadeInUp，delay = index * 60ms

### 选中态：列表 + 详情

- 点击卡片 → 网格收为左侧单列列表，右侧滑入详情面板
- 详情面板内容：
  - 技能名称 + 描述
  - 标签（可编辑）
  - 应用状态列表（该 Skill 在每个目标的状态）
  - 每个目标的行内「应用 / 收回」
  - SKILL.md 预览
- 关闭详情：点 ✕ 或 Esc → 列表展开回网格

### 状态转换动效

- 网格 → 列表：`grid-template-columns` 动画 300ms，卡片形态简化
- 详情面板进入：`translateX(16px) + opacity:0` → 正常，400ms ease-out-expo，delay 100ms
- 列表 → 网格：详情先滑出 200ms，列表展开 300ms delay 100ms，卡片交错入场

## 目标视角

### 布局

- 中间列表：所有目标平级展示（全局目录 + 各项目）
- 每个目标条目：图标 + 名称 + 路径 + 统计（N 已应用 / M 未应用）
- 右侧详情：选中目标后展示其下所有 Skill 的状态

### 目标详情

- 已应用 Skill 排在顶部，完整不透明，右侧显示「收回」按钮
- 未应用 Skill 半透明，右侧显示「应用」按钮
- 有问题的 Skill 显示红点 + 问题描述 + 「覆盖」按钮
- 底部保留「批量应用…」按钮，弹小弹窗勾选后一次完成

### 操作流

**给新项目配 Skill（5 步）：**
1. 切到「目标」视角
2. 选中项目
3. 通过搜索和标签筛选定位 Skill
4. 行内点击「应用」或「覆盖」
5. 状态刷新确认

**从技能视角分发单个 Skill（4 步）：**
1. 选中 Skill 卡片
2. 在详情抽屉查看各目标状态
3. 在目标行内点击「应用」或「收回」
4. 状态刷新确认

## 状态模型

### 3 种状态

| 状态 | 视觉 | 含义 |
|------|------|------|
| 已应用 | 绿点 + 正常不透明度 | 软链接存在且指向主库 |
| 未应用 | 灰点 + 半透明 | 目标位置不存在该 Skill |
| 有问题 | 红点 + 问题描述 | 冲突/失效/路径异常，需用户处理 |

### v1 状态映射

- `enabled` → 已应用
- `disabled` → 未应用
- `unmanaged` / `conflict` / `broken` / `pathMissing` / `invalid` → 有问题（附具体问题描述）

## 设计系统

### 风格

Premium Utilitarian Minimalism. 暖色单色系 + 编辑式排版 + ultra-flat + 淡彩语义点缀。

### 色彩

| Token | 值 | 用途 |
|-------|-----|------|
| Canvas | `#FBFBFA` | 页面背景 |
| Surface | `#FFFFFF` | 卡片、面板 |
| Border | `#EAEAEA` | 所有边框和分割线 |
| Text Primary | `#2F3437` | 正文 |
| Text Secondary | `#787774` | 辅助信息 |
| Text Tertiary | `#A8A5A0` | 最弱层级 |
| Interactive | `#111111` | 按钮、选中态 |
| Accent Green | `#EDF3EC` / `#346538` | 已应用状态 |
| Accent Red | `#FDEBEC` / `#9F2F2D` | 有问题状态 |
| Accent Blue | `#E1F3FE` / `#1F6C9F` | 信息 |
| Accent Yellow | `#FBF3DB` / `#956400` | 警告 |

### 排版

| 用途 | 字体 | 大小 |
|------|------|------|
| Page Title | Instrument Serif | 36-42px, -0.03em |
| Section Heading | SF Pro Display 500 | 15px |
| Body | SF Pro Display 400 | 13px, line-height 1.6 |
| Meta/Path | SF Mono | 10-11px |
| Tags | SF Pro Display 500 | 10px, uppercase, 0.05em tracking |

### 组件规则

- 卡片：`border: 1px solid #EAEAEA`，`border-radius: 8px`，`padding: 16px`
- 按钮主要：`bg: #111`，`color: #fff`，`border-radius: 6px`，hover → `#333`，active → `scale(0.98)`
- 按钮次要：`bg: transparent`，`border: 1px solid #EAEAEA`，hover → `border-color: #CCC`
- 标签：pill 形状，10px uppercase，使用语义淡彩背景
- 筛选 chips：pill，`bg: #F7F6F3`，active → `bg: #111 color: #fff`

### 动效规范

| 动效 | 参数 | 用途 |
|------|------|------|
| Scroll Entry | translateY(12px) + opacity, 600ms ease-out-expo | 页面内容进入 |
| Card Hover | box-shadow 0→2px 8px rgba(0,0,0,0.04), 200ms | 卡片悬停 |
| Staggered Reveal | delay = index * 60ms | 网格卡片依次入场 |
| Detail Panel In | translateX(16px) + opacity, 400ms ease-out-expo | 右侧面板进入 |
| Grid ↔ List | grid-template-columns, 300ms | 视图切换 |
| Button Press | scale(0.98), 200ms | 按下反馈 |

### 性能规则

- 只动画 `transform` 和 `opacity`
- IntersectionObserver 驱动 scroll entry
- 尊重 `prefers-reduced-motion`：关闭所有动画
- `will-change` 仅在动画进行时添加

## 技术方向

- 保留 Tauri 2 + React + TypeScript + SQLite
- 前端从单文件 App.tsx（179KB）拆为组件化架构
- 后端消除 Agent 概念，数据模型简化为 Skill + Target
- 删除 30+ 旧设计文档的增量 patch，以本 spec 为唯一事实源

## 不做什么

- 不做技能组合独立入口
- 不做技能组合 / Preset，标签是唯一分组体系
- 不做 7 种细分状态
- 不做 Agent 多实例管理
- 不做复杂 onboarding 流程（首次启动一屏确认目录即可）
- 不兼容早期历史数据库，不保留旧表迁移
- 不做覆盖前备份和操作日志（v1 已明确不做）
- 不做营销首页、市场浏览
- 不用 Inter/Roboto/Open Sans
- 不用 Lucide/Feather（当前依赖需替换为 Phosphor Icons）
- 不用渐变、发光、玻璃拟态、深色阴影

## 验证标准

重构完成后必须满足：

1. 启动桌面应用正常
2. 技能视角网格全览 → 选中详情 → 关闭回网格，流程顺畅
3. 目标视角选中目标 → 行内应用/收回 → 状态即时更新
4. 搜索和标签筛选在 78 个 Skill 下响应即时
5. 给新项目配 Skill ≤ 5 步完成
6. 所有动效在 `prefers-reduced-motion` 下关闭
7. 窗口 800x600 ~ 1440x900 下布局不溢出
