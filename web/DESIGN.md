# AICGuard 视觉设计规格（DESIGN.md）

> 依据：grill 会话共识（2026-10-03，Q1–Q9）+ `web-design` / `frontend-design` / `web-design-guidelines` skill 流程。
> 适用范围：`web/console.html`、`web/index.html`，以及后续衍生界面（视频片头/片尾、未来页面）。
> 一句话定位：给评委看的安全体检工具——气质是**测量仪器 / 工程报告**，不是营销落地页。大胆只花在一处（看板 KPI hero 数字），其余克制。

## 0 版本决策记录

- v1（2026-10-03 上午）：暗色石墨 + 青色强调。用户审核反馈：「不要过于暗色和圆角」。
- v2（2026-10-03）：**浅色工程风**——白面板 + 冷灰底 + 细线分隔 + 收紧的圆角（面板 4 / 控件 3）。参考方向：主流 SAST/数据工具的浅色报告界面；录屏场景下文字清晰度也最优。
- v3（2026-10-03）：用户看了 4 个方向小样（工程报告纸 / 深顶栏控制台 / 学术衬线报告 / 瑞士网格黑白）后定调「**数据要突出**」→ 融合方案：**深顶栏工作台骨架**（工具身份感）+ **数据放大策略**（hero 数字 96px、右栏数值 22px、数据以外的装饰全部退后）。浅色底、方角、等宽数字不变。
- v4（2026-10-03）：用户指定「**B 和 C 结合**：B 的数据条进度 + C 的风格 + 动态感」→ 见 §7 v4 增补。
- v5（2026-10-03，当前）：用户定调「**渐变暗色，可以有些圆角，动态粒子感**」→ 见 §8 v5 增补。§2 色彩 token 表与 §4 圆角规格以 §8 为准（浅色版规格保留作历史）。结构层（双层报告头 / 章节体系 / 三线表 / 数据动画编排）沿用 §7。
- v7（2026-10-05，**仅 console.html**）：自进化可视化重塑配套的视觉重做——「**实验室仪器台**」：浅色工程风为默认（与材料 architecture.png / knowledge_graph.png 同语言，投影可读），侧边导航（仪器通道选择器）+ 四视图骨架；状态一律信号灯（good/bad/warn/run 脉冲）；衬线视图标题 + 等宽数字；暗色降级为可选主题（沿用 v5/v6 色板与 localStorage 机制）。index.html（看板）本轮不动，仍为 §8/§9 外观。
- v8（2026-10-05，**仅 console.html**）：用户反馈「保留前端之前的动画感和组件的设计」→ 定调「**动效全回 + 质感融合**」——v7 骨架（侧边导航 + 视图划分 + 浅色默认 + 信号灯）不动，v5/v6 的动效与组件质感回归：粒子背景、KPI 数字滚动、进度条生长、卡片入场；卡片轻玻璃化、按钮渐变、徽章胶囊、KPI 大数字渐变字；新增「05 报告看板」视图（iframe 内嵌 dashboard.html 在线观看）。见 §11。

## 1 视觉方向

- 关键词：工程报告 / 仪器读数 / 纸面测量记录。
- 受众：AIC 算法创新赛评委，在 4~5 分钟录屏内建立可信度。
- 氛围：白色报告纸 + 深青墨水——浅冷灰底、白面板、发丝线分隔，颜色只给数据判定。

## 2 色彩 token（唯一来源，两页共用同一套值）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#f5f7f9` | 页面底（冷浅灰，非暖奶油底） |
| `--panel` | `#ffffff` | 面板 / 卡片 / 表格底 |
| `--panel2` | `#eef1f4` | 表头、次级底、行 hover |
| `--line` | `#d9dee3` | 边框 / 分隔线（发丝线） |
| `--fg` | `#1c2733` | 正文（深板岩，非纯黑） |
| `--muted` | `#5c6b7a` | 辅助文字 / 图标 |
| `--accent` | `#0c6f81` | 强调：读数、链接、当前项（深青，"墨水"意象；浅底上必须用深青而非暗色版的亮青） |
| `--good` / `--warn` / `--bad` | `#1a7f4b` / `#8a6116` / `#c73e4a` | 语义三色，只用于数据判定，不做装饰 |
| `--input` | `#f7fafb` | 输入框 / 代码 / 证据块底（比 panel 沉半档） |

对比度（WCAG，node 实算 2026-10-03）：fg/panel 15.1:1，muted/panel 5.5:1，accent/panel 5.8:1，白字/accent 底 5.8:1，good 5.0:1，warn 5.5:1，bad 5.0:1——全部 ≥ 4.5:1（AA）。

## 3 字体与层级

- 正文栈：`-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`（零依赖，不打包 webfont）。
- **数字一律 `--mono`（ui-monospace / Cascadia Mono / Consolas）+ `tabular-nums`**：KPI、表格数值、延迟、run_id、canary 编号——测量工具的题材刚需，也是全页最重的性格来源。
- 层级：h1 21px/600 + 盾形 SVG logo 21~22px ｜ h2 15px/600 + accent 左缘 3px + 线性图标 ｜ 正文 14px ｜ 辅助 12.5px ｜ hero 数字 56px mono/700。
- 禁：ALL-CAPS eyebrow、「标题里一个词变色」、装饰性渐变字。

## 4 空间与形状（4/8pt 网格）

- 间距只用 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40。
- 容器 max-width：控制台 1080 / 看板 1180；页面上下留白 24，底部 60。
- 面板 padding 20；面板间距 16；h2 上方 32。
- **圆角语言（v2 收紧为工程方角）**：面板/表格 4 ｜ 按钮/输入/答案块 3 ｜ 徽章/rec-tag 2 ｜ 药丸形废弃。形状语言 = 报告纸的直角感，不做"柔和 SaaS"。
- 无阴影：层次靠 1px 发丝线 + 底色差（panel 白 vs bg 浅灰）表达，不堆柔影。

## 5 组件与状态

- **图标语言**：24 viewBox、stroke 1.8、round cap/join、`currentColor`、落地 15px；全部自绘（与盾形 logo 同手势，零授权依赖；Iconfont 实地结论：线性 + 约 1.8 笔画，但下载需登录且授权不一，故自绘）。
- 按钮：底 `--accent` 白字；hover 加深（`#0a5f6f`）；active 再深（`#08505d`）；focus-visible 2px `--accent` outline offset 2。
- 输入：focus 边框 `--accent` + `0 0 0 3px rgba(12,111,129,.15)` 外环。
- 表格行 hover `--panel2`；chip hover 边框 `--accent`。
- 动效：只回应操作（hover / focus / 确认结果），120~150ms ease；无页面级装饰动画；`prefers-reduced-motion` 下全部关闭。

## 6 反 AI 味自查（本项目映射）

- 已清除：emoji 图标、GitHub Dark 默认色值、两套主题拼接、6 等宽 KPI 卡栅格、营销腔（原本就没有）、暗色"荧光单强调"模板脸（v2 离开该集群）。
- 刻意保留并说明理由：等宽数据字（题材刚需）、语义三色（体检报告必需）、左缘 3px accent 标记（全站统一的"装订线"结构语言，只用于区块开头和 hero）。
- 禁止：渐变 / 玻璃拟态 / 假评价假数据 / 每卡片柔影堆叠 / 页面装饰动画 / 暖奶油底 + 陶土色（frontend-design 点名的另一类模板脸）。

## 7 v4 增补（B+C 融合，当前生效）

- **双层报告头**：顶层深板岩色工具栏（`#1f2937`，logo + 面包路径 + run 号/状态灯，工具骨架）；其下内容区用 C 式居中衬线报告头（kicker「AICGuard · 评测报告」+ 衬线大标题「中文大模型安全体检报告」+ 居中元信息行 + 2px 粗规线）。
- **衬线章节体系**：h2 改衬线（`--serif`，Source Han Serif / Noto Serif / STZhongsong / SimSun 栈）+ mono 章节号 `01…09`；v3 的 h2 图标与左缘 3px 线**退役**（章节号接棒结构标记；盾形 logo 只留在顶栏与 favicon）。
- **三线表（书版式）**：表格去外框去底色，表头上 2px 粗线 + 下 1px 线，行间 1px 细线，末行下 2px 粗线；行 hover 保留。分攻击族表行尾保留进度条。
- **进度条**：细高 8px、直角 2px、`--w` 变量驱动宽度。
- **动效（载入一次性编排，之后全静态）**：① KPI 数字从 0 滚动到终值（900ms easeOutCubic，`data-count` 驱动）；② 进度条从 0 生长（800ms）；③ 内容块整体上浮淡入（450ms）。`prefers-reduced-motion` 下全部关闭、直接呈现终值。控制台结果区仅有用户触发的 250ms 上浮。

## 8 v5 增补（渐变暗色 · 粒子 · 圆角回归，当前生效）

- **背景**：body 固定渐变 `linear-gradient(160deg,#101826,#0a0d13 60%,#0b101a)`；其上铺全屏 canvas 粒子层（`#particles`，z-index 0，pointer-events none）：≤90 个缓慢漂移的青色粒子，间距 <130px 时连半透明细线，页面隐藏时暂停渲染，`prefers-reduced-motion` 下不启动。内容容器 z-index 1。
- **玻璃面板**：面板/卡片 = 半透明渐变底 `rgba(30,42,60,.55)→rgba(18,26,38,.65)` + `backdrop-filter:blur(10px)` + 1px `rgba(148,163,184,.14)` 边线（粒子在玻璃后产生景深）。
- **渐变强调**：hero 数字与 kicker 用青→蓝渐变文字（`#4cc3d6→#60a5fa`，background-clip:text）；按钮用同族渐变底 + 深色文字 `#0b1622`（对比度 6.4:1）。语义三色数据条保持纯色（数据诚实性，不用渐变）。
- **圆角回归（"可以有些圆角"）**：面板/hero 12 ｜ 卡片 10 ｜ 按钮/输入/证据块 8 ｜ 徽章药丸 999 ｜ rec-tag 4 ｜ 进度条 2。
- **v5 色彩 token**：`--fg:#e6edf5` ｜ `--muted:#8fa0b3` ｜ `--accent:#4cc3d6` ｜ `--good:#3fd68c` ｜ `--warn:#e0a83f` ｜ `--bad:#ff6b78` ｜ 输入/证据底 `rgba(10,14,20,.6)`。对比度（node 实算，按面板最不透明底 `#141c29`）：fg 14.5:1、muted 6.4:1、accent 8.2:1、good 9.1:1、warn 8.0:1、bad 6.2:1、按钮深字 6.4:1——全部 ≥ 4.5:1（AA）。
- **三线表换暗色**：粗细规线改 `rgba(230,237,245,.55/.35)`，行线 `rgba(148,163,184,.12)`，行 hover `rgba(148,163,184,.06)`。
- **动效叠加**：§7 的载入编排保持；粒子是唯一的常驻动效（用户点名"动态粒子感"，属 brief 指定），速度压到最低（≤0.35px/帧）保证不抢数据。

## 9 v6 增补（明暗双主题切换，当前生效）

- **机制**：全部主题相关值收敛为 CSS 变量（含三线表规线、玻璃底、进度条槽、顶栏、按钮/hero 渐变、focus 环），`html[data-theme="dark|light"]` 两套 token；SVG 图表颜色全部改走 `style="fill/stroke:var(--x)"`（presentation attribute 不支持 var()），随主题即时切换。
- **策略**：首次访问跟随 `prefers-color-scheme`；点顶栏右侧日/月按钮手动切换后写入 `localStorage("aicguard-theme")`；未手动选择时监听系统偏好变化实时跟随。初始化脚本放在 `<head>` 内、样式应用前执行，避免闪色。
- **联动项**：`theme-color` meta 与 favicon（暗=深底青盾 / 浅=白底深青盾）随主题更新；粒子配色随主题（暗=亮青，浅=深青低透明度）。
- **浅色玻璃**：面板底 `rgba(255,255,255,.92→.78)` + 同款 blur；语义色用浅色版深值（v2 色板），对比度已实算达标。
- **按钮图标语义**：显示的是**切换目标**——暗色下显示太阳、浅色下显示月亮。
- 两主题共用全部结构（§7）与动效（§7/§8），切换零 JS 重渲染，纯 CSS 变量级联。

## 10 v7 增补（console.html 四视图骨架，当前生效 · 仅控制台）

- **骨架**：`aside` 侧边导航（深色仪器通道选择器，01–04 编号 + 主标题 + 一行说明）+ `main` 四个 `.view`（体检台 / 攻击试探 / 评测中心 / 进化实验室），切换纯 class 翻转 + 220ms 入场动画（`prefers-reduced-motion` 时关闭）。
- **信号灯语言**：状态一律 `.dot`（good=绿晕 / bad=红晕 / warn=黄晕 / run=青色脉冲）——体检台自检、跑批进行态、进化流程步骤共用同一语义，不另造图标。
- **层次**：视图头 = 等宽 kicker（`AICGUARD · 控制台`）+ 衬线 26px 视图标题 + 一句人话说明；卡片 = 白底 4px 圆角 + 发丝线；数据一律等宽 tabular-nums。
- **token**：`--side/--side-fg/--side-muted` 三值管理侧栏；其余沿用 v2 浅色板 + v6 双主题机制（`aicguard-theme` 键，`<head>` 内预设防闪色）。
- **演进实验室流程条**：`.flow` 四步卡（选 run → 生成候选 → 人工审核 → 合并复验），当前步 `inset 3px` 青色描边——自进化闭环在 UI 上的进度语言。

## 11 v8 增补（console.html 动效质感融合 + 报告看板视图，当前生效 · 仅控制台）

- **粒子背景回归**：`#particles` canvas（fixed 底层 z-0，aside/main 抬 z-1），IIFE 与看板/旧控制台逐行同款（数量 min(90, W·H/22000)、连线 130px、`cols()` 每帧读 `dataset.theme` 实时换色、reduced-motion 早退、`visibilitychange` 暂停、resize 重置）。
- **组件质感**（token 明暗两套）：`--glass-grad` + `.card{backdrop-filter:blur(10px)}` 轻玻璃卡（圆角回 12px）；`--btn-grad/--btn-text` 渐变按钮（hover brightness 1.12 / active .92，ghost 保持描边）；`.badge` 胶囊 999px；`--hero-grad` + `.kpi .v` 渐变文字（background-clip:text，count-up 的 span 随父级裁剪）。输入/chip 圆角同步 8px/999px。
- **动效**：`.card`/`.cand` 入场 `rise .45s`（innerHTML 重建自动重播）；`.bar>i` 进度条 `grow .8s cubic-bezier(.2,.7,.3,1)`（`--w` 内联注入，good/warn/bad 阈值色，默认 accent 单色给无好坏语义的占比条）；KPI 数字滚动 `animateCounts()`（rAF 900ms ease-out 三次方，`data-count/data-dec/data-suf` 机制，reduced-motion 直出终值）。应用点：体检台 KPI 磁贴 + 自进化摘要、评测中心主评测 KPI 网格、agent 四档矩阵行尾 ASR 条、体检台语料资产占比条。
- **05 报告看板视图**：nav 第五项；run 下拉（`/api/runs` 过滤 `hasDashboard`，默认最近）+ `.card` 内 iframe 加载 `/runs/<id>/dashboard.html`（自包含文件，同源无障碍）+ 新标签打开按钮；**主题联动**：控制台切主题时同步 `iframe.contentDocument` 的 `data-theme`（try/catch 包裹，未加载静默跳过）；评测中心结果卡「在线查看报告 →」与两处历史列表的「看板」链接均走 `openReport(runId)` 跳转预选。
- **退出码语义沉淀**：run.ts / agent-eval.ts 的退出码是 CI 门禁语义（发现 high 级缺口 → 1），server.ts 对 `eval`/`agent-eval` 且 report.json 落盘的任务向前端归零（`gateExit` 保留原码）；evolve-merge 非零 = 门禁真失败，不归零。
