# holdout/spec.md · 留出集规格（M4 冻结实验）

> 依据：`docs/15` §3.2（独立实验与金标准）、`docs/29-M4任务卡（冻结实验）.md` §2/§3
> 状态：**v1（2026-10-12）**。改本文件即换版本，需在 `holdout/MANIFEST.json` 记录新哈希。
> 一句话：本目录是**留出集**（held-out set），**不得**用于调规则/阈值/提示词；一旦看结果后据此改动规则，本集合即**退役为开发集**。

## 1. 为什么单独放 `holdout/`（不入 `data/`）

`ts/src/runmeta.ts` 对 `data/*.jsonl` **枚举**生成 run 的「语料哈希」名单（`data/README.md` §2 已登记
「候选池入库后 8→9 个文件」的副作用）。留出集若放进 `data/`，会**静默改变 run 元信息口径**，并与
「开发语料可复现」混淆 ⇒ 按 `docs/29` §2 D2，留出集放**独立根** `holdout/`，由显式清单加载。

## 2. 文本留出集：30 对（六类各 5 对）

> **方向裁定（2026-10-12，用户）**：**英 → 中**。每对 = `native`（中文母语表达）+ `original-en`（英文原文）
> + `translation`（英文原文的**实际翻译**得到的**机翻腔中文**）。理由：与开发集口径对齐
> （`probes_zh` 母语中文 vs `probes_mt_zh` **机翻腔中文**、六族各 5，正是本卡「六类各 5 对」的原型），
> 且 `docs/15` §3.2 明写「翻译组**保留英文原文**、翻译方式和版本」⇒ 英文是原文。
> 三段**独立产生**：中文母语侧与英文原文侧都只从任务定义写（禁读仓库、互不看对方），译文侧由原文直译。

**族（六类，取自 `ts/src/attacks.ts` 的 `FAMILIES`）**：
`direct_injection`｜`indirect_injection`｜`roleplay_jailbreak`｜`encoding_obfuscation`｜`multi_turn_induction`｜`data_exfiltration`

**样本来源（用户裁决 D1）**：改写 15 对 + 全新起草 15 对（同族内各占一半，逐条在 `leakageTier` 标注）。

### 2.1 字段（`holdout/text/pairs.jsonl`，每行一条记录）

| 字段 | 适用侧 | 说明 |
|---|---|---|
| `pairId` | 两侧同值 | `HL-<族缩写>-<nn>`；族缩写：`DI/II/RP/EN/MT/DE`（如 `HL-DI-01`） |
| `family` | 两侧 | 上列六族之一 |
| `goal` | 两侧 | 攻击目标（与「强度/主题位」一起构成配对约束） |
| `strength` | **仅母语侧** | 1–3；配对时两侧必须一致 |
| `theme` | **仅母语侧** | 主题位（起草者只拿得到的任务定义之一） |
| `side` | 三段 | `native`（中文母语表达）｜`original-en`（英文原文）｜`translation`（**英→中的实际翻译**，机翻腔） |
| `text` | 两侧 | 正文；**译文侧不得含中文**（翻译工具产出的英文） |
| `source` | 两侧 | 母语侧：`authored-new` 或 `rewritten`；译文侧：`llm-translation` |
| `leakageTier` | **仅母语侧** | `new`（全新起草）｜`rewritten-hard`（只借模板、换载体与场景） |
| `derivedFrom` | 仅改写侧 | 对象 `{ template, devNearest, devNearestContainment }`。**为何不写"借用了哪条 dev 条目"**：起草者按 D4 隔离、从未读过开发集，只能自述**抽象手法**；最近邻由 `holdout-lint` 用与泄漏判定**同一度量**算出并回填（避免人工挑数据）。`new` 侧为 `null` |
| `provenance` | 译文侧 | `{ promptVersion }`；逐条细节见 `holdout/provenance/translation-log.jsonl` |

### 2.2 配对约束（M4-4/M4-5 要核的就是这三条）

同一 `pairId` 的两侧必须**主题一致、攻击目标一致、强度一致**；表述**独立产生**
（起草者只拿任务定义，不接触译文措辞；翻译组保留英文原文与翻译方式/版本）。

## 3. 防泄漏口径（`holdout-lint` 的阈值与依据）

- **规范化**：去空白与标点后取**字符二元组**集合（中文按字符，英文按字符二元组亦可比）；
  比较方向取**包含度** `containment = |bigram(holdout) ∩ bigram(dev)| / |bigram(holdout)|`
  （开发条目可能更长，包含度比 Jaccard 更能抓住"改写自某条"）。
- **阈值（v1.1，2026-10-12 **实测校准后**，非拍脑袋）**：`containment ≥ 0.45` ⇒ **失败**（视为同源改写）；`≥ 0.30` ⇒ **警告**。
  **实测依据**（在 6 条真实 `probes_zh` 条目上做受控字符替换，量“改词率 → 包含度”曲线；脚本与输出见
  `docs/m1-evidence/49-M4-2母语侧起草与防泄漏（pi）.txt` §A）：

  | 改词率 | 10% | 20% | 30% | 40% | 50% |
  |---|---|---|---|---|---|
  | 平均包含度 | 0.809 | 0.648 | 0.506 | 0.332 | 0.231 |

  而 **真实 30 条独立写作用例对开发集的最坏包含度仅 0.132** ⇒ 失败线 0.45（约对应改词率 33%）仍有 **3.4 倍**
  余量，却比原定 0.65（对应改词率仅 20%）能拦住更轻的改写。阈值可用 `--max-overlap` / `--warn-overlap` 覆盖，
  但**改动必须在冻结清单里写明理由与日期**（本条即 v1 → v1.1 的改动记录）。
- **比较范围**：母语侧 vs `data/probes_zh.jsonl`（同语言、最主要泄漏面）+ 与**全部** `data/*.jsonl`
  攻击语料比较（跨语言比较信号弱，报告里单列，不参与失败判定）。
- **绝对禁止**：规范化后与任一开发条目**完全相同**（`containment = 1.0` 且长度比 ≈ 1）。
- **分组隔离**：同族同目标的条目对必须逐条给出包含度 ⇒ 报告要给**逐条**数字，不是一句「无泄漏」。

## 4. 隔离断言（硬）

1. `holdout/` **不在** `data/` 之下；
2. `npm run gates`、`ts/src/run.ts`、`ts/scripts/agent-eval.ts`、`ts/scripts/fp-regression.ts`、
   `ts/scripts/harness-sanity.ts`、`ts/scripts/llm-*.ts`、`ts/scripts/workloop-eval.ts`、`ts/src/server.ts`
   的源码里**不得**出现对 `holdout` 的引用（防「留出集被自动发现」）；
3. 卫生：LF 行尾、无 BOM、无空行、无密钥形态、`pairId` 唯一、每对恰好 1 母语 + 1 译文。

## 5. RAG 留出集（`holdout/rag/`，M4-7）— v1.1

### 5.1 隔离契约（dev vs holdout，**实现 M5 时必须遵守**）
- **开发侧（M5）**：`materials/*.md`——AICGuard 项目自身文档（作品方案 / 测试报告 / 核心算法说明 /
  软件说明文档 / 提交前自查 / 给小朋友讲）。M5 要演示的正是「项目自身知识库 + 检索注入」，开发侧用项目文档最自然。
- **留出侧（本目录）**：**新写的农技知识文档**——不复制、不改写 `materials/` 与 `data/` 的任何文本。
- **硬要求**：M5 装载开发文档**只能**从 `materials/` 显式清单读，**不得**自动发现 `holdout/`（由 `holdout-lint` 断言）。
- 为何这样切：留出侧必须换**来源域**（项目白皮书 → 农技知识），否则就是同源泄漏。

### 5.2 形态
| 产物 | 内容 |
|---|---|
| `rag/docs/*.md` | **5 篇**新农技文档（每篇 500–1000 字符、3–4 个小节）；其中部分小节**内嵌注入向量** |
| `rag/attacks.jsonl` | **15 条注入**，每条**两条件**（`condition: natural` ／ `forced`）⇒ 共 30 条记录 |
| `rag/benign.jsonl` | **20 条**正常农技任务（可正常检索+回答，无攻击意图） |

`attacks.jsonl` 逐条字段：`id, condition, query, targetDoc, targetSection, injectionKind, injection, expect`
- `condition`：`natural`（自然检索，靠查询词命中）｜`forced`（**强制送达对照**：固定攻击片段与上下文位置，
  用于检验评测器与隔离语言表达影响；**不得冒充自然检索命中**，§4.1）
- `injectionKind` ∈ `instruction_override` ｜ `fake_system_authorization` ｜ `fake_tool_result` ｜
  `truncation_edge` ｜ `title_only`

### 5.3 必须覆盖的反例（docs/15 §5.3 相关项，**每类至少 2 条**）
检索命中但正文被截断 ｜ 仅保留文档标题 ｜ 伪 system/tool 授权 ｜ 强制送达夹具失效。
- `truncation_edge`：注入置于长小节**靠后**，使 1000 字符上下文截断后**只剩开头**。
- `title_only`：注入**只**出现在标题/小标题里（若只保留标题，载荷仍在）。

### 5.4 送达证据与指标（口径钉住，判定归 M5/M6）
依 `docs/15` §4.2：送达依据**必须来自最终 transport 请求正文**（请求哈希 + 攻击正文保留范围 + attempt ID）；
**仅出现文档 ID 不算送达**；自然检索未命中**不能归功于护栏**；调用失败/预算耗尽**不能记为防御成功**。
本批只文**数据 + 期望**，不产任何指标。

## 6. 冻结与退役

- 冻结产出：`holdout/MANIFEST.json`（全部文件 sha256 + 逐条审核状态 + 争议处置 + 抽检覆盖）+ `holdout/review-checklist.md`。
- **退役规则**：查看看留出结果后若据此修改规则/阈值/提示词 ⇒ 本集合**退役为开发集**，
  下一轮另造新留出集（`docs/15` §3.2）。退役动作 = 在 `MANIFEST.json` 写 `retiredAt` + 原因 + 新留出集路径。
