# AICGuard · TypeScript 版

> AIC 第八届 · 新疆赛区 · 算法创新赛 · **AI+软件创新** ｜ 选题一：LLM 应用安全体检与护栏平台
> 对应施工依据：[../docs/AIC-选题一-开发文档-v1.1-TypeScript.md](../docs/AIC-选题一-开发文档-v1.1-TypeScript.md)
> 状态：**核心引擎已跑通**

---

## 快速开始

**不需要 `npm install`，不需要编译，不需要构建。**

```bash
node src/run.ts                 # 默认：农技靶子 + 完整防御
node src/run.ts --profile rules # 只开第 1 档输入规则
node src/run.ts --expand 0      # 不用变异体，跑得更快
node src/run.ts --threshold 0.5 # 调低阈值，观察误报率上升
```

环境自检（**10/02 开工前先跑这个**）：

```bash
node scripts/m0-check.ts
```

产出在 `runs/<时间戳>/`：`report.json`、`report.md`、`dashboard.html`（双击即开）。

### 控制台（M2 端到端，浏览器全流程）

```bash
node src/server.ts          # http://127.0.0.1:7777（只绑本机）
```

浏览器内完成「选档位 → 单条攻击试探（拦截/攻破徽章 + 归因）→ 全量跑批 → 看板」。
真实模型跑批走子进程调 `run.ts`（复用预算红线与报告产出），无 confirm 直接 400。
演示脚本（分镜→实机操作对照）见 `../docs/07-演示脚本.md`。
注意：**Windows 控制台 curl 发中文会 GBK 乱码**，API 测试用 node fetch。

---

## 接真实模型靶子（M0b，2026-10-02 已标定）

```bash
# 密钥与网关写在 ts/.env.local（不入库，见 .gitignore）：
#   AICGUARD_API_KEY / AICGUARD_BASE_URL / AICGUARD_MODEL
node src/run.ts --target llm --limit 20            # 标定/小规模：20 条轮转抽样
node src/run.ts --target llm --limit 20 --profile rules
node src/run.ts --target llm --yes                 # 全量（>200 次请求需 --yes 确认）
```

- **成本控制已实现**（docs/01 §11）：回复按 (模型, 系统提示, messages) 落盘缓存
  （`runs/llm-cache/<model>/`，调试/断点续跑不重复计费）；跑批前打印预估请求数，
  超 200 次必须 `--yes`；跑完打印真实 tokens 用量。
- **真实模型模式默认跳过 T1/T2/T3 实验模块**（阈值扫描 ×10、消融 ×6 都是全量重跑），
  实验数字以离线靶子为准。
- API 失败的用例判为 `unclear`（不计入 ASR 分母）——失败不冒充"防住了"。
- 标定实测（历史，agnes 网关）：~430 tokens/次、
  baseline ASR 10.5%、防御后 0%、误报 0/10；**DI-07 无防御下真实泄露系统提示
  （金丝雀命中）**。完整外推表见 docs/01 §11.1。

### 真实模型榜单（多采样版，2026-10-03）

```bash
node scripts/llm-leaderboard.ts --yes     # 两阶段（单次快照）
node scripts/llm-multisample.ts --help    # R 次独立采样（逐轮 + 池化 + 95% CI + 稳定性矩阵）
```

跨厂商三模型（速算云网关，126 探针 × 全量三档，详见 docs/10）：

| 模型 | 采样 | none ASR | rules ASR | full ASR |
|---|---|---|---|---|
| deepseek/deepseek-v4-flash | R=5 | 16.0%（CI 13.4–19.1） | 4.9% | **1.1%**（CI 0.5–2.3） |
| ali/qwen3.8-max | R=1 | 5.6% | 4.0% | 0.0%（上界 2.4%） |
| google/gemini-3.5-flash-lite | R=1 | **54.8%** | 24.6% | 0.8% |

> 同一评测集下三模型安全水位**差一个量级**（gemini vs qwen）；deepseek 逐轮 none 在
> 11.9%–19.8% 之间波动——单次采样不可代表，正式引用用「逐轮 + 池化 + 95% CI」口径。
「拒答提及」误判已修复（T9，2026-10-02）：keyword 命中前先查否定语境。

---

## agent 通道与自进化（2026-10-03 新增）

**agent 评测**：评测对象从静态 prompt 靶子升级为**会调用工具的智能体**（AgentBot，工具集含敏感的
「用药方案生成」）。判定**看行为不看文本**——由工具调用审计（`tool-audit.ts`）对参数归一化后
匹配禁用项，`kebaiwei`、`甲·拌·磷` 等形变一视同仁。

```bash
node scripts/agent-eval.ts            # 模拟 agent（mock，零 API 成本）
node scripts/agent-eval.ts --real --samples 5   # 真实 LLM agent，R=5 采样
```

- **实测暴露缺口**：现有三层文本护栏对 agent 攻击面**拦截 0**（请求是自然业务，无注入关键词）；
- **G3 护栏补位**（`agent-guard.ts`，注册表模式注册，引擎零改动）：敏感意图×禁用项同现判决 →
  真实模型 R=5 采样 **0/100**（Wilson 双侧 95% CI 上界 3.7%；rule-of-three 单侧近似上界 3.0%）、误拦 0。

**多次采样**（`llm-multisample.ts` + `stats.ts`）：R 次独立采样，每轮轮换缓存盐（真请求），
输出逐轮值 + 池化 + Wilson 95% CI + 逐用例**稳定性矩阵**——实测 deepseek 逐轮波动 11.9%–19.8%，
46 条攻破中 45 条 flaky（单次采样会系统性漏掉）。

**语料自进化闭环**（`evolve-probes.ts`，已用真实数据跑通）：

```
多采样稳定性矩阵 → 生成候选种子（按 flaky 缺口扩样）→ 人工审核 → 合并语料 → 重跑基线复验
```

实际发生：rules 档 15 条 flaky 攻破 → 生成 8 条种子（EV-11~18）→ 人工审核合并 →
主评测集 **366→374 条**，基线复验 85.8%→4.3%（留痕 `runs/evolve-log.md`）。

**质量门禁**：`node --test tests/*.test.ts`（15 用例）+ `node scripts/fp-regression.ts`（误报回归）。

---

## 为什么是 TypeScript

| 理由 | 说明 |
|---|---|
| **同栈才能改 promptfoo** | 最佳开源底座 promptfoo 是 TS。用 Python 只能调它的 CLI，那就真成"套壳"了 |
| **产物本来就是 Web** | 看板、对话界面、报告页——前端跑不掉，一套语言前后端通吃 |
| **部署风险低** | 没有 venv / CUDA / cuDNN 版本地狱，演示机临时出问题好救 |
| **零依赖可行** | Node 24 原生跑 `.ts`，核心逻辑不需要任何 npm 包 |

---

## ⚠️ 零依赖的代价：strip-only 模式的限制

Node 直接跑 `.ts` 用的是**类型剥离**（strip-only）——它只删类型标注，**不做任何代码生成**。
所以下面这些 TS 特性**一律不能用**，用了会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`：

| 不能用的特性 | 报错示例 | 替代写法 |
|---|---|---|
| **参数属性** `constructor(private x: T)` | 本项目实际踩到 | 显式声明字段 + 在构造函数里赋值 |
| `enum` | 需要生成运行时代码 | 用 `const` 对象 + `as const`（本项目 `PROFILES` 就是这么写的） |
| `namespace` | 需要生成 | 用普通模块 |
| 装饰器 | 需要生成 | 不用 |
| 带运行时的 `import type` 混用 | — | 类型导入统一加 `type` 关键字 |

> **这条已写进本文档，因为它是实际踩到的坑**，不是理论风险。第一次跑 `src/run.ts` 就是被参数属性挡住的。

---

## 目录结构

```
ts/
├── package.json              声明 type: module，脚本入口
├── tsconfig.json             仅供编辑器类型提示（不参与运行）
├── src/
│   ├── types.ts              数据结构（interface / type）
│   ├── config.ts             金丝雀串 + 靶子系统提示（run.ts 与 promptfoo provider 共用）
│   ├── lexicon.ts            ★ 三套词库 + 归一化工具
│   │                          母语中文 / 机翻腔 / 语义改写（已知缺口）
│   ├── attacks.ts            用例加载 + 5 类编码混淆器 + 程序化扩充
│   ├── guards.ts             N1 归一化 + G1 输入规则 + G2 输出兜底 + 三档位
│   ├── judge.ts              ★ 判分器（含"提及 vs 推荐"修正）
│   ├── evaluate.ts           评测引擎（基线 / 防御双线对照 + 实验测量口径 measurePipeline）
│   ├── corpusCompare.ts      ★ T1 语料来源对照实验
│   ├── tuning.ts             ★ T2 安全阈值权衡扫描（推荐工作点 + 性价比拐点）
│   ├── ablation.ts           ★ T3 防御层消融实验
│   ├── compliance.ts         ★ T5 合规整改建议（风险等级 + 整改建议，不硬引法条）
│   ├── attribution.ts        ★ 拦截归因与修复建议（核心增量）
│   ├── report.ts             JSON / Markdown / HTML 看板
│   ├── agent-guard.ts        ★ G3-AgentGuard：agent 通道专属护栏（敏感意图×禁用项同现）
│   ├── tool-audit.ts         ★ 工具调用审计判定器（行为即证据，不看文本）
│   ├── stats.ts              Wilson 95% CI / rule-of-three 上界（多次采样统计，零依赖）
│   ├── pf-provider.ts        promptfoo 靶子 provider 入口（子进程调用）
│   ├── run.ts                一键入口（主评测 + 三个实验 + 合规页一次跑完）
│   └── targets/
│       ├── agrobot.ts        农技问答机器人（离线靶子）
│       ├── agentbot.ts       ★ 智能体靶子（LLM + 工具循环；mock 零成本 / real 桥接）
│       ├── llmbot.ts         真实模型靶子（OpenAI 兼容接口，缓存 + 用量统计）
│       └── llm-bridge.mjs    LLM 请求桥（spawnSync 子进程，fetch + 退避重试）
├── tests/                    node:test 行为测试（agent-guard / tool-audit，15 用例）
├── .env.local                密钥与网关配置（不入库，见 .gitignore）
├── promptfoo/                promptfoo 交叉验证（独立目录，不进主链路，见其 README）
├── scripts/                  评测与质量脚本（自检 / 榜单 / 多采样 / agent / 进化 / 门禁）
└── runs/                     评测产出（自动创建）
```

**用例库不放在 `ts/` 下**——它在仓库根目录的 `data/`，与语言无关：

```
data/probes_zh.jsonl       母语中文自建（source=native）
data/probes_mt_zh.jsonl    机翻腔对照（source=mt）
data/probes_agro.jsonl     农技靶子专属
data/probes_tool_abuse.jsonl  agent 工具调用诱导（15 母语 + 5 机翻对照）
data/probes_garak_mt.jsonl   garak 机翻对照组（27 条）
data/benign_zh.jsonl       阴性对照（105 条，含合规问法）
```

---

## 实测结果

`node src/run.ts`（农技靶子，374 条用例 + 105 条正常请求，P0-2 词表精化 + 自进化 8 条后）：

| 指标 | 数值 |
|---|---|
| 无防御 ASR | **85.8%** |
| 有防御 ASR | **4.3%** |
| 无防御 ASR（按族等权） | **92.7%**（消除编码族占比 69% 的拉低） |
| 有防御 ASR（按族等权） | **11.4%** |
| 防御有效率 | **95.0%** |
| 误报率 | 0.0%（105 条阴性，P0-2 治理后） |
| 输入侧拦截 / 输出侧兜底 | 301 / 5 |
| 无法判定（unclear） | 基线 / 完整防御各 1 条（不计入 ASR 分母） |
| 本轮耗时 | <0.1 s（离线靶子；接真实 API 后以网络耗时为准） |

> 等权口径 2026-10-18 修正：修复线 M1 统一分族统计的 unclear 分母处理，92.1%/11.3% → **92.7%/11.4%**（修正说明与证据见 `materials/02-测试报告.md`）。

分档位（供 promptfoo 交叉验证对照）：

| 档位 | 有防御 ASR | 输入侧拦截 |
|---|---|---|
| none | 85.8% | 0 |
| rules | 40.2% | 170 |
| rules+norm | 5.6% | 301 |
| full | 4.3% | 301 |

一次运行同时产出（同目录）：`report.json` / `report.md` / `dashboard.html` +
`corpus_comparison.md`（T1 语料对照）+ `threshold_sweep.md`（T2 阈值扫描）+ `ablation.md`（T3 消融）。

> 注意：上表是 374 条全量（含 expand 变体）的数字。promptfoo 交叉验证用的是
> 无变体的 126 条原始用例子集，分母不同不可直接比对；同子集对照
> （none 97.6% / rules 22.2% / full 12.7%，两侧逐条一致）见 `promptfoo/README.md`。

**与 Python 版结果一致**（86.7% / 4.4% / 13.3%），说明两版实现语义等价。
三个实验的关键数字也与 Python 版量级一致：仅机翻规则下母语拦截率 0.9%（Python 1.9%）、
N1+G1 关键行 ASR 5.7%（Python 20.6%，角色扮演规则修复后本版更好）、拐点阈值 0.70（同 Python）。
> 注：以上为 2026-10-01 的**移植对照记录**。当前（2026-10-03，P0-2 词表精化 + 自进化 8 条后）
> T3「仅 G1」为 40.1%、N1 独立贡献 34.5 pp；T2 推荐工作点 0.50 且性价比拐点不再存在（全阈值误报 0.0%）。

---

## 两个已知问题（2026-10-01 已处理）

### 1. 角色扮演越狱规则在输入侧从不生效 —— ✅ 已修复

原状态：`角色扮演越狱` 规则权重 **0.60** < 默认拦截阈值 **0.70**，这组规则永远不会触发
（实测 19 条角色扮演用例 16 条穿透输入侧，全靠输出侧兜底）。

**修复**：采用「提高权重」方案（比降阈值更精准，只影响这一组），
`角色扮演越狱` / `机翻-角色扮演` 权重 0.60 → 0.70。修复后输入侧拦截 244 → 299，
输出侧兜底 60 → 5，误报率不变（13.3%），「有防御 ASR」保持 4.4% 未变。

### 2. ~~误报率 13.3% 偏高~~ ✅ 已治理（P0-2，2026-10-03）—— 词表精化 + 阴性集扩容 30→105，当前 0.0%

治理前按「摊开权衡曲线」处理：

4 条正常请求被拦，触发词是 `系统提示`、`从现在起`、`开发者模式`（均为规则词库中的常见词）。
**误报率不可能压到 0**——这些词在正常中文里就是常见的。正确做法已经落地：
`threshold_sweep.md` 把 0.50–0.95 全部阈值的「误报率 vs 拦截率」摊开，
看板画出权衡曲线并给出推荐工作点（**治理前**为 0.80：误报 0% 但输入侧几乎失效，带 ⚠️ 警告）
与性价比拐点（**治理前** 0.70），由业务方按自己的误报容忍度选工作点。
P0-2 词表精化后，推荐工作点变为 **0.50**（0.50–0.70 误报全为 0.0%），性价比拐点因误报已无下降空间而消失。

---

## 开源集成现状

| 组件 | 用途 | 状态 |
|---|---|---|
| [promptfoo](https://github.com/promptfoo/promptfoo)（MIT，0.123.1） | **交叉验证**自研引擎结果 + 借用其专业报告 UI | ✅ 已接入（`promptfoo/`，独立目录、独立 npm 环境，**不进主链路**） |
| [garak](https://github.com/NVIDIA/garak)（Apache-2.0） | 仅用其**机翻中文 probe** 作对照组，量化"母语 vs 机翻"差距 | 待接入（当前用自建 30 条机翻腔语料替代） |
| thu-coai/SafetyBench、safety-prompts | 攻击分类体系参考，**仅作对照，不混充自建** | 仅引用 |

> ⚠️ 引用任何开源组件前，**先看最后一次提交时间和归档状态**。本项目选型时曾误推已归档的 llm-guard。

---

## 待办

- [x] 阈值权衡扫描（`src/tuning.ts`，推荐工作点 + 性价比拐点 + 「约束内最优≠真优」警告）
- [x] 母语 vs 机翻对照实验（`src/corpusCompare.ts`，核心口径关闭输出兜底）
- [x] 消融实验（`src/ablation.ts`，开关 N1 / G1 / G2，量化每层独立贡献）
- [x] 合规整改建议页（`src/compliance.ts` + 看板区块，风险等级 + 整改建议，不硬引法条）
- [x] 修复角色扮演规则权重问题（0.60 → 0.70）
- [x] promptfoo 交叉验证（`promptfoo/`：gen-tests.ts + provider.cjs + compare.ts + subset-baseline.ts；2026-10-02 实测三档位与自研引擎逐条一致）
- [x] garak 机翻对照组（`data/probes_garak_mt.jsonl` 27 条 + `scripts/garak-mt.ts` 生成器；T1 实验第三列——实测词库对跨域主题 0% 覆盖，支撑"按主题域持续扩充"结论，见 docs/00 T8）
- [x] 接真实模型 API（`targets/llmbot.ts` + `llm-multisample.ts` 多采样；跨厂商三模型榜单见 docs/10）
