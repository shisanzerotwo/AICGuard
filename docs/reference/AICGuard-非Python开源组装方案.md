# 选题一 · 基于开源项目的五种落地路线（非 Python 优先）

> 日期：2026-10-01 ｜ 口径：省赛 30 天
> 上游：[AIC-省赛-3个融合选题.md](AIC-省赛-3个融合选题.md)（选题一）｜[AICGuard-开发文档评审意见.md](AICGuard-开发文档评审意见.md)

---

## 0. 先说三件重要的事

### ① 你的核心资产跟语言无关

之前那版 Python 原型里，真正值钱的不是代码，而是三样**换任何技术栈都带得走**的东西：

| 资产 | 为什么值钱 |
|---|---|
| **366 条中文攻击用例**（母语 333 + 机翻腔 33），6 大攻击族，逐条标注设计意图 | 这是原创性论证的主体，也是最花时间的部分 |
| **判据设计 + "提及 vs 推荐"的坑** | 直接决定 ASR 数字可不可信 |
| **三个已经跑出来的实验结论** | 母语 vs 机翻差 63 个百分点；调阈值救不了规则；归一化层独立贡献 30.4 个百分点 |

**换技术栈不丢这些。** 下面的五条路线，差别只在"用什么壳把这三样装起来"。

### ② "不用 Python"有两种理解，我都覆盖

| 你的意思 | 看哪几个 |
|---|---|
| 不想写 Python 代码 | 路线 1（TypeScript）、3（TypeScript）、4（Java） |
| 不想从零写代码，想直接组装现成项目 | 路线 1、2、5（都是**配置驱动**，几乎不写代码） |

每条路线我都标了 **"你要写多少代码"**，按这个字段选最快。

### ③ 一条不能碰的线

无论走哪条路线，**增量必须落在"中文母语攻击语料 + 判据 + 归因"上**。
如果只是把 promptfoo / garak 跑一遍截图交上去，会被判定为**没有实质增量**——大赛有原创性复核，且查实后取消全部成绩并通报学校。

---

## 1. 五条路线总览

| | 路线 1 | 路线 2 | 路线 3 | 路线 4 | 路线 5 |
|---|---|---|---|---|---|
| **底座** | promptfoo | Dify | n8n | LangChain4j / Spring AI | garak |
| **技术栈** | TypeScript / Node | 低代码平台（Docker） | TypeScript | **Java** | Python（但只写配置） |
| **你要写多少代码** | 少量 JS 断言 + YAML | 几乎为零（可视化） | 少量 JS 节点 | 中量 Java | 几乎为零（CLI + 配置） |
| **自带 Web 报告** | ✅ 有 | ✅ 有 | ⚠️ 需自己搭 | ❌ 无 | ⚠️ 有 HTML 报告 |
| **增量落点** | 中文 probe 集 + 中文判据 | 靶子应用 + 中文语料 | 编排 + 归因节点 | 中文护栏规则 | 中文 probe + 判据 |
| **30 天可行性** | ★★★★★ | ★★★★ | ★★★★ | ★★★ | ★★★★★ |
| **撞车风险** | 中（用 promptfoo 的队可能多） | 中 | 低 | **最低** | 中高 |
| **演示观感** | 报告页很专业 | **最好**（能对话） | 流程动画 | 偏后台 | 命令行，偏弱 |
| **最大风险** | 像"套壳" | Docker 部署重 | 学术味弱 | Java 生态薄 | 增量容易被质疑 |

---

## 2. 路线卡片

---

### 路线 1 · promptfoo —— 中文红队评测平台 ★首选

**底座**：[promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)（MIT，22k+ star）
它是**声明式**的 LLM 评测工具：你写 YAML 描述测试用例，它负责跑批、判分、出报告。带 Node API（[官方文档](https://www.promptfoo.dev/docs/usage/node-api-reference/)），可以编程扩展。

**为什么它最适合"少写代码"**
你自己要写的只有三样：
1. **YAML 用例文件**——把 366 条中文攻击用例写成 promptfoo 的测试格式；
2. **自定义断言（JS）**——实现"提及 vs 推荐"的中文判据；
3. **自定义 provider（JS）**——把你的靶子应用（农技问答机器人）接进去。

跑批、并发、报告 UI、对比矩阵，**全都是它自带的**。

**你的增量**
- **中文母语 probe 集**（garak 的机翻中文 probe 作对照组）
- **中文判据**：promptfoo 自带断言是英文语境的，中文的"提及 vs 推荐"必须自己写
- **拦截归因**：哪个防御层漏了 → 这条要自己在断言里输出

**演示形态**：终端敲一条命令 → 浏览器打开 promptfoo 自带报告页，红绿表格 + 逐条详情。**观感专业**，而且几乎不花力气。

**30 天排期**
| 时间 | 内容 |
|---|---|
| 10/02-10/03 | 装 promptfoo（`npx promptfoo`）+ 跑通官方 demo |
| 10/04-10/08 | 366 条用例转 YAML + 写中文断言 |
| 10/09-10/15 | 接靶子 provider + 端到端跑通 |
| 10/16-10/24 | 指标体系 + 归因 + 三组对照实验 |

**风险与对策**
- ⚠️ **"这不就是 promptfoo 套个壳？"** —— 这是最需要防的质疑。对策：把方案的重心写成"**中文母语攻击语料库的构建方法与判据设计**"，promptfoo 只出现在"技术选型"一章，且明确列出我们改了什么（自定义断言、中文 probe 格式、归因扩展）。
- promptfoo 版本迭代快，YAML schema 可能变 → 第 2 天就锁版本号。

---

### 路线 2 · Dify —— 农技问答机器人 + 安全体检 ★演示最好

**底座**：[Dify](https://github.com/langgenius/dify)（LLMOps 开源平台，Docker Compose 自托管，[官方部署文档](https://docs.dify.ai/getting-started/install-self-hosted/docker-compose)）

**核心思路变了**：不是"写一个评测平台"，而是——
**用 Dify 可视化搭出一个真实的农技问答机器人（零代码），然后给它做安全体检。**

**你要写什么**
- 在 Dify 里拖出"知识库检索 + 大模型 + 提示词"的工作流（**全程点点点**）
- 知识库直接喂公开农技资料
- 体检脚本用 HTTP 节点调用 Dify 的 API，或者干脆用 Postman/curl 手跑

**你的增量**
- 中文攻击语料 + 判据（同上）
- **"本地部署应用的安全基线"**：同一套 Dify 工作流，分别接云端 API 模型和本地 Ollama 模型，测安全差异——这是别人给不出的对比

**演示形态**：**最好的一条**。评委能亲眼看到 Dify 界面里，用户问"棉铃虫怎么防"，机器人正常回答；然后输入一条攻击，机器人开始推荐禁用农药——然后打开护栏档位，同样的攻击被拦下。**全过程可视化，说服力最强。**

**30 天排期**：Dify 部署 2 天 → 工作流搭建 2 天 → 语料 4 天 → 体检脚本 3 天 → 剩余同上。

**风险与对策**
- ⚠️ **Docker 部署重**：api / worker / web / db / redis / weaviate 六七个容器，**建议内存 ≥8GB**。教学机可能吃不住。对策：先在本地或云服务器跑通，再决定是否上演示机。
- ⚠️ Dify 的二次开发要走插件 API，比直接改代码受限。所以**把 Dify 定位成"靶子应用"，而不是"评测平台"**——评测逻辑仍在你手里。

---

### 路线 3 · n8n —— 攻击编排流水线

**底座**：[n8n](https://github.com/n8n-io/n8n)（TypeScript，可视化工作流自动化，[自托管文档](https://docs.n8n.io/deploy/host-n8n/deploy-with-the-ai-starter-kit)）

**核心思路**：把"发攻击 → 收回复 → 判分 → 记录 → 汇总"画成一条工作流。

- `HTTP Request` 节点发攻击到靶子
- `Switch` / `IF` 节点按攻击族分流
- `Code` 节点（写 JS）实现中文判据
- `Google Sheets` / `Postgres` 节点落库
- `Chart` 节点出图

**你要写什么**：主要是**拖节点 + 少量 JS**。编排逻辑不用写。

**你的增量**：中文用例库 + 判据节点 + 归因分支。

**演示形态**：画布上点"执行"，**看着数据在节点间流动**，很直观。但学术味偏弱。

**30 天可行性** ★★★★。**风险**：n8n 本质是通用自动化工具，不是评测工具——评委可能觉得"用 n8n 做这个有点勉强"。适合作为**辅助工具**（比如自动跑批 + 落库），而不作为作品主体。

---

### 路线 4 · LangChain4j / Spring AI —— Java 企业栈 ★撞车最低

**底座**：
- [LangChain4j](https://github.com/langchain4j/langchain4j)（Apache-2.0）——有专门的护栏模块，[`dev.langchain4j.guardrails`](https://docs.langchain4j.dev/apidocs/dev/langchain4j/guardrails/package-summary.html)，含 `DecisionModelInputGuardrail` 等现成实现
- 或 [Spring AI](https://github.com/spring-projects/spring-ai)（Apache-2.0）——有 Advisors API 做拦截

**核心思路**：做一个**企业级 LLM 安全网关**——Java 服务挂在业务系统和模型之间，做输入检测、输出过滤、审计日志。

**你的增量**
- **中文护栏规则**（现成的护栏都是英文语境）
- 中文攻击用例 → 用来验证护栏
- 审计与合规报告（Java 企业场景天然要求这个）

**为什么撞车最低**：**几乎没有学生队用 Java 做 LLM 安全**。评委面前的差异化很强，而且"企业 Java 栈"这个定位在答辩时很好讲。

**风险与对策**
- ⚠️ **Java 侧 LLM 安全生态很薄**：没有 garak / promptfoo 这样的现成红队工具，评测部分要自己写。
- ⚠️ 建模时间：Spring Boot + LangChain4j 上手 2-3 天。
- 对策：**评测用现成工具（promptfoo/garak），产品用 Java 写**——两条腿走路，各取所长。但这会让工作量增加，需要砍掉别的。

**适合**：队伍里有人 Java 很强、且不想碰 Python。

---

### 路线 5 · garak CLI —— 最省力的"用现成工具"

**底座**：[NVIDIA/garak](https://github.com/NVIDIA/garak)（Apache-2.0）——LLM 漏洞扫描器，只通过**命令行 + 配置文件**使用，**不需要你写 Python**。

**核心思路**：不写平台，用 garak 做扫描引擎，你**只贡献中文语料和报告**。

```bash
garak --model_type openai --model_name deepseek-chat \
      --probes <中文probe集> --report_prefix zh_scan
```

**你的增量**
- **中文母语 probe 集**（garak 自带机翻，所以你必须证明"母语"的价值——这正是那条 63 个百分点的对照实验）
- 中文判据（garak 的 detector 也是英文语境）
- 中文报告与归因

**30 天可行性** ★★★★★（最省力）。**风险**：增量最容易被质疑——"你只是跑了 garak"。
**对策**：把重心 100% 压在**语料构建方法与对照实验**上，garak 只作为执行器出现。适合时间极度紧张时的保底路线。

---

## 3. 怎么选（三个问题）

**Q1：你能接受写代码吗？**
- 完全不想写 → **路线 2（Dify）** 或 **路线 5（garak CLI）**
- 愿意写一点 → **路线 1（promptfoo）** ★推荐
- 愿意写不少，但要差异化 → **路线 4（Java）**

**Q2：演示要靠什么打动人？**
- 靠专业报告页 → 路线 1
- 靠"亲眼看到机器人被攻破又被拦住" → **路线 2** ★
- 靠 Java 企业级定位 → 路线 4

**Q3：最怕什么？**
- 怕被说"套壳" → 避开 1 和 5，选 **2 或 4**
- 怕部署踩坑 → 避开 2，选 **1 或 5**
- 怕撞车 → 选 **4**

---

## 4. 我的推荐：路线 2 为主，路线 1 为辅

**理由**：

1. **路线 2 把"靶子应用"这件事做到了极致。** 竞赛作品的说服力很大程度来自"评委能看懂发生了什么"。Dify 界面里看着机器人正常回答、被攻击后开始推荐禁用农药、再开启护栏后被拦住——**这个画面的说服力，比任何报告页都强**。而且农技场景在新疆有天然共鸣。

2. **路线 1 补足评测侧。** Dify 不擅长跑批和出报告，promptfoo 正好补上，而且自带专业报告 UI。两者通过 Dify 的 API 对接。

3. **两条路线共用同一批资产**（366 条中文用例 + 判据 + 对照实验），所以并行推进的成本很低——**语料只需要写一遍**。

4. 如果时间不够，**砍掉路线 1**，用 Dify + 一份手工评测报告也能交；反过来砍掉路线 2 也成立。**互为备份，风险最低。**

---

## 5. 无论走哪条，这三件事今天就要做

1. **10/02 当天验证环境**：Dify 的 Docker Compose 能不能跑起来（内存够不够）；promptfoo 能不能 `npx` 跑通。**装不上立刻换路线**——这是最容易在最后一刻翻车的地方。
2. **10/02 实测 API 限速与成本**（用 20 条用例标定），外推全量再决定榜单规模。参考[评审意见](AICGuard-开发文档评审意见.md)第二节：**5 模型 × 5 档位 = 25 轮，成本是单轮的 25 倍**。
3. **10/15 20:00 前完成报名缴费**（500 元/赛题/团队），涉及对公转账要走学校流程，别拖到最后一天。

---

## 附：本篇核实记录（2026-10-01）

- [promptfoo Node API 文档](https://www.promptfoo.dev/docs/usage/node-api-reference/) → 确认它是 Node/TypeScript 生态，支持编程扩展
- [LangChain4j `dev.langchain4j.guardrails` 包](https://docs.langchain4j.dev/apidocs/dev/langchain4j/guardrails/package-summary.html) + [DecisionModelInputGuardrail](https://docs.langchain4j.dev/apidocs/dev/langchain4j/guardrails/DecisionModelInputGuardrail.html) → 确认 Java 侧确有护栏模块
- [Dify Docker Compose 部署文档](https://docs.dify.ai/getting-started/install-self-hosted/docker-compose) → 确认多容器自托管
- [n8n 自托管部署文档](https://docs.n8n.io/deploy/host-n8n/deploy-with-the-ai-starter-kit) → 确认可用 AI starter kit 部署

> 上一版曾推荐已归档的 llm-guard。**引用任何开源组件前，先看最后一次提交时间和归档标记。**
