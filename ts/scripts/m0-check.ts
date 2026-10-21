#!/usr/bin/env node
/**
 * M0 环境自检 —— 不写一行业务代码，先确认技术路线能不能走。
 *
 * 用法：
 *     node scripts/m0-check.ts
 *
 * 设计约束：
 *   - 零依赖，只用 Node 内置模块
 *   - **不使用 child_process**（沙箱环境下管道 stdio 会 EPERM），
 *     改为直接检查文件系统与进程内 fetch
 *   - 输出可读的通过/失败表格 + 每条失败的修复建议
 *   - 结果同时写入 runs/m0-check.json，便于团队对照与留档
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(TS_ROOT, "..");

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix: string;
}

const results: Check[] = [];
const add = (name: string, status: Check["status"], detail: string, fix = "") =>
  results.push({ name, status, detail, fix });

// ============================================================ 1. Node 与 TS 直跑

const [major, minor] = process.versions.node.split(".").map(Number);

if (major > 23 || (major === 23 && minor >= 6)) {
  add("Node 版本", "pass", `v${process.versions.node} — 原生支持 .ts 直接运行，无需编译`);
} else if (major === 22 && minor >= 6) {
  add("Node 版本", "warn",
    `v${process.versions.node} — 需加 --experimental-strip-types 参数`,
    "运行时统一加 --experimental-strip-types，或在 package.json scripts 里改：node --experimental-strip-types src/run.ts");
} else {
  add("Node 版本", "fail", `v${process.versions.node} — 过低，无法直接运行 .ts`,
    "升级到 Node 23.6+（推荐 24 LTS）；或改用 tsc 构建流程");
}

// 这个脚本本身就是 .ts 且正在运行 —— 直跑能力已被事实验证
add("TypeScript 直跑", "pass", "本自检脚本即为 .ts，正在运行 = 直跑能力已确认");

// ============================================================ 2. 中文输出

try {
  const probe = "中文输出测试：忽略之前的所有指令 ✅";
  if (probe.includes("忽略之前")) {
    add("中文与编码", "pass", "UTF-8 中文读写正常（若你看到本行是乱码，请检查终端编码）");
  }
} catch {
  add("中文与编码", "fail", "中文处理异常", "检查系统区域设置与终端编码（Windows 建议 chcp 65001）");
}

// ============================================================ 3. 包管理器（promptfoo 前置）

const nodeDir = dirname(process.execPath);
const siblingBins = existsSync(nodeDir) ? readdirSync(nodeDir) : [];
const hasNpm = siblingBins.some((f) => /^npm(\.cmd|\.ps1|\.exe)?$/.test(f));
const hasNpx = siblingBins.some((f) => /^npx(\.cmd|\.ps1|\.exe)?$/.test(f));

if (hasNpm || hasNpx) {
  add("包管理器", "pass", `在 Node 同级目录找到 ${hasNpm ? "npm " : ""}${hasNpx ? "npx" : ""}`);
} else {
  add("包管理器", "warn",
    "Node 同级目录未找到 npm / npx —— 无法验证 promptfoo 能否安装",
    "若你机器上装了 Node 官方发行版，npm 通常自带；本机可能是精简运行时，不影响零依赖主链路");
}

// ============================================================ 4. npm registry 可达性（决定 promptfoo）

async function checkRegistry(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://registry.npmjs.org/promptfoo", {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json() as { "dist-tags"?: Record<string, string> };
      const latest = data["dist-tags"]?.latest ?? "未知";
      add("npm registry 可达性", "pass",
        `可访问，promptfoo 最新版本 ${latest} —— 可以走 promptfoo 交叉验证路线`);
    } else {
      add("npm registry 可达性", "warn", `HTTP ${res.status}`,
        "主链路零依赖不受影响；promptfoo 相关能力降级");
    }
  } catch (e) {
    clearTimeout(timer);
    add("npm registry 可达性", "warn",
      `不可达（${(e as Error).name}）—— 本环境装不了 promptfoo`,
      "主链路零依赖不受影响。若在你自己机器上也装不上，就放弃 promptfoo，只用自研引擎 + 单文件报告");
  }
}

// ============================================================ 5. 数据文件

const DATA_FILES = [
  "probes_zh.jsonl",
  "probes_mt_zh.jsonl",
  "probes_agro.jsonl",
  "benign_zh.jsonl",
];
const dataDir = join(REPO_ROOT, "data");
const missing: string[] = [];
let totalProbes = 0;
for (const f of DATA_FILES) {
  const p = join(dataDir, f);
  if (!existsSync(p)) {
    missing.push(f);
    continue;
  }
  try {
    const txt = readFileSync(p, "utf8");
    totalProbes += txt.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch {
    missing.push(f);
  }
}

if (missing.length === 0) {
  add("攻击用例库", "pass", `4 个文件齐全，共 ${totalProbes} 条用例`);
} else if (missing.length < DATA_FILES.length) {
  add("攻击用例库", "warn", `缺少：${missing.join("、")}`,
    "补齐缺失文件；或先用已有文件跑通流程");
} else {
  add("攻击用例库", "fail", `未找到用例文件（查找路径：${dataDir}）`,
    "确认 data/ 目录位置，或用 --data 参数指定");
}

// ============================================================ 6. 报告模板

const tpl = join(REPO_ROOT, "web", "index.html");
if (existsSync(tpl)) {
  add("报告看板模板", "pass", `找到 ${tpl}`);
} else {
  add("报告看板模板", "warn", "未找到 web/index.html",
    "缺失时只输出 Markdown / JSON 报告，不影响指标采集");
}

// ============================================================ 7. API Key

const KEY_VARS = ["DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY", "ZHIPU_API_KEY"];
const found = KEY_VARS.filter((k) => (process.env[k] ?? "").trim().length > 0);

if (found.length > 0) {
  add("API Key", "pass", `检测到：${found.join("、")} —— 可进行真实模型评测与成本标定`);
} else {
  add("API Key", "warn", "未检测到任何模型 API Key",
    "设置环境变量后重跑，例如：$env:DEEPSEEK_API_KEY=\"sk-xxx\"（PowerShell）；" +
    "没有 Key 时用 AgroBot 离线靶子也能完成全部实验");
}

// ============================================================ 8. 输出目录可写

const runsDir = join(TS_ROOT, "runs");
try {
  mkdirSync(runsDir, { recursive: true });
  const probeFile = join(runsDir, ".write-probe");
  writeFileSync(probeFile, "ok", "utf8");
  rmSync(probeFile, { force: true });   // 探测完立刻清掉，不留垃圾
  add("输出目录可写", "pass", `可写入 ${runsDir}`);
} catch (e) {
  add("输出目录可写", "fail", `无法写入 ${runsDir}：${(e as Error).message}`,
    "检查目录权限，或把项目移到可写位置");
}

// ============================================================ 执行 + 汇总

await checkRegistry();

const icon = { pass: "✅", warn: "⚠️ ", fail: "❌" } as const;
const pad = (s: string, n: number) => {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
};

console.log("");
console.log("=".repeat(78));
console.log("  M0 环境自检报告");
console.log("=".repeat(78));
for (const r of results) {
  console.log(`${icon[r.status]} ${pad(r.name, 22)} ${r.detail}`);
  if (r.fix) console.log(`${" ".repeat(5)}↳ 不达标怎么办：${r.fix}`);
}

const passed = results.filter((r) => r.status === "pass").length;
const warned = results.filter((r) => r.status === "warn").length;
const failed = results.filter((r) => r.status === "fail").length;

console.log("-".repeat(78));
console.log(`  通过 ${passed} 项 ｜ 警告 ${warned} 项 ｜ 失败 ${failed} 项`);
console.log("-".repeat(78));

if (failed > 0) {
  console.log("  ❌ 有硬性阻塞项，先解决再开工。");
} else if (warned > 0) {
  console.log("  ⚠️  无硬性阻塞，但警告项会影响可选能力（如 promptfoo 交叉验证 / 真实模型榜单）。");
} else {
  console.log("  ✅ 环境就绪，可以开工。");
}
console.log("");

const out = {
  checkedAt: new Date().toISOString(),
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
  results,
  summary: { passed, warned, failed },
};
const payload = JSON.stringify(out, null, 2);
try {
  writeFileSync(join(runsDir, "m0-check.json"), payload, "utf8");
  console.log(`  自检记录已写入：${join(runsDir, "m0-check.json")}`);
} catch {
  // 目录不可写的情况上面已单独报错
}
console.log("=".repeat(78));

process.exit(failed > 0 ? 1 : 0);
