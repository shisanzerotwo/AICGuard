#!/usr/bin/env node
/**
 * 发布包打包：dist/AICGuard-发布包-<日期>.zip
 *
 * 包内容 = 可运行软件本体（不含密钥、不含评测产出、不含交叉验证环境）：
 *   ts/src + ts/scripts + ts/package.json + tsconfig.json
 *   web/ + data/ + docs/（文档）+ README.md + start.bat / start.sh
 *
 * 刻意排除：.env.local（密钥红线）、ts/runs（评测产出含缓存）、ts/promptfoo
 * （交叉验证可选环境，含 node_modules 数百 MB，评审验证不需要）。
 * materials 只带四份正文 .md（RAG 通道的默认知识库），不带 PDF / 视频 / 图片。
 *
 * 用法：node scripts/release.mjs   （Windows 下用 PowerShell Compress-Archive 压缩）
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROOT, "dist", "AICGuard");
// 本地日期（toISOString 是 UTC，会在本地凌晨差一天）
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ZIP = join(ROOT, "dist", `AICGuard-发布包-${date}.zip`);

rmSync(join(ROOT, "dist"), { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// 复制白名单
const entries = [
  ["ts/src", "ts/src"],
  ["ts/scripts", "ts/scripts"],
  ["ts/tests", "ts/tests"],
  ["ts/package.json", "ts/package.json"],
  ["ts/tsconfig.json", "ts/tsconfig.json"],
  ["web", "web"],
  ["data", "data"],
  ["holdout", "holdout"],
  ["README.md", "README.md"],
  ["start.bat", "start.bat"],
  ["start.sh", "start.sh"],
];
for (const [from, to] of entries) {
  const src = join(ROOT, from);
  if (!existsSync(src)) throw new Error(`缺 ${src}`);
  cpSync(src, join(STAGE, to), { recursive: true });
}

// docs/ 只带面向评审的公开文档（00–13 + reference）。
// 任务卡、证据转录、复核记录与 agent 交接属于开发过程材料，不进发布包。
const docsDir = join(ROOT, "docs");
mkdirSync(join(STAGE, "docs"), { recursive: true });
for (const f of readdirSync(docsDir)) {
  const m = /^(\d{2})-.+\.md$/.exec(f);
  if (m && Number(m[1]) <= 13) cpSync(join(docsDir, f), join(STAGE, "docs", f));
}
if (existsSync(join(docsDir, "reference"))) {
  cpSync(join(docsDir, "reference"), join(STAGE, "docs", "reference"), { recursive: true });
}

// materials/ 只带四份正文：RAG 通道默认把它们当知识库文档，缺了会导致默认评测与测试失败。
const matDir = join(ROOT, "materials");
mkdirSync(join(STAGE, "materials"), { recursive: true });
for (const f of readdirSync(matDir)) {
  if (/^0[1-4]-.+\.md$/.test(f)) cpSync(join(matDir, f), join(STAGE, "materials", f));
}

// 安全自检：包内不得出现密钥文件或密钥内容
const dangerous = ["ts/.env.local", "ts/runs", "ts/promptfoo", "dist"];
for (const d of dangerous) {
  if (existsSync(join(STAGE, d))) throw new Error(`安全自检失败：包内出现 ${d}`);
}
const envExample = join(STAGE, "ts", "src", "targets", "llmbot.ts");
if (readFileSync(envExample, "utf8").includes("sk-")) throw new Error("源码中出现密钥字样");

// 包内速览
writeFileSync(join(STAGE, "使用说明.txt"),
  [
    "AICGuard · 中文大模型安全评测与护栏平台 — 发布包",
    "",
    "最快上手（Windows）：双击 start.bat，浏览器自动打开 http://127.0.0.1:7777",
    "macOS/Linux：bash start.sh",
    "",
    "要求：Node.js >= 23.6（零第三方依赖，无需 npm install）",
    "详细说明：docs 内文档 + materials 同名在线文档；本包 ts/.env.local 需自行创建后才可使用真实模型靶子（离线靶子开箱即用）",
    "",
    "生成日期：" + date,
  ].join("\n"), "utf8");

// 压缩（Windows 自带 PowerShell；tar 亦可但 zip 对评审更友好）
execFileSync("powershell", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`,
], { stdio: "inherit" });

const size = statSync(ZIP).size;
console.log(`发布包完成：${ZIP}（${(size / 1024 / 1024).toFixed(2)} MB）`);
