# data/ 目录说明

> 本目录同时存放**评测语料**与**候选池（暂存态）**，两者用途不同，引用数字前必须先分清。

## 1. 评测语料（正式口径，只读使用）

| 文件 | 用途 |
|---|---|
| `probes_zh.jsonl` | 母语中文攻击用例（含历史进化用例） |
| `probes_mt_zh.jsonl` | 机翻腔中文攻击用例 |
| `probes_agro.jsonl` | 农技场景攻击用例（离线靶子 AgroBot 配套） |
| `probes_garak_mt.jsonl` | garak 机翻对照组 |
| `probes_tool_abuse.jsonl` | agent 工具越权用例（含多轮） |
| `probes_workloop.jsonl` | 成本/预算耗尽用例 |
| `benign_zh.jsonl` | 阴性对照（正常请求，测误报） |
| `sanity_positive.jsonl` | 必破样本（评测器阳性自检） |

评测入口通过**显式文件清单**加载这些文件；门禁（`npm run gates`）只读上述语料，不读候选池。

## 2. 候选池：`probes_candidates.jsonl`（**不是**评测语料）

- **性质**：语料进化（`ts/scripts/evolve-probes.ts`）产出的候选暂存池，含 `approved` / `rejected` / `pending`
  三种状态。**`approved` 只表示"审核通过"，不等于"已合并进评测语料"**（实测：46 条 approved 与全部语料
  文件 id 零重叠，即尚未合并）。
- **入库（M3-1，2026-10-12）**：该文件以前被 `.gitignore` 排除，现改为**入库跟踪**，以便候选状态变更可被
  快照与提交记录复现（决策与代价见 `docs/21-M3任务卡（保护数据）.md` §2 D1）。
- **⚠️ 内容包含未审数据**：本文件含 `pending`（未审）与 `rejected`（拒收）条目，以及未经人工复核的 LLM
  生成文本。**不得**用它计算任何对外指标、不得从中直接取用例做评测；`rejected` 条目保留仅为审计留痕。
- **写入方**：只允许候选事务模块（`ts/scripts/evolve-probes.ts` 与其共享写入模块）写入；同一时刻只允许一个写者。
  ⚠️ 入库后该路径在修复工作区**真实存在** ⇒ 直接跑 `evolve-probes.ts generate` 会**修改一个被跟踪的文件**，
  不再是"写到忽略目录"，请在有版本/锁保护的前提下操作（M3-3 的双审核事务与独占锁就是为此）。
- **读取方**：控制台候选页（`ts/src/server.ts`）与合并脚本。**评测引擎不读它**。
- **副作用提醒**：`ts/src/runmeta.ts` 的语料哈希按 `data/*.jsonl` **枚举**，因此新 run 的"语料哈希"
  名单会从 8 个文件变成 **9 个**（多出本文件）。引用语料哈希时请按"评测语料 8 个 + 候选池 1 个"理解；
  快照语义（M3-4）必须显式区分评测语料集与暂存池。

## 3. 内容体检

入库前后可随时运行（只读，不写文件）：

```bat
cmd.exe /c "node docs\m1-evidence\31-candidate-pool-check.mjs data\probes_candidates.jsonl"
```

检查：JSON 可解析 / `id` 唯一 / `status` 合法 / 必填字段 / LF 行尾 / 无 BOM / 密钥形态 0 命中，
并如实列出已知数据问题（当前：10 条 `multi_turn_induction` 缺 `turns`、10 条缺 `judge`、42 条缺 `origin_run`）。
