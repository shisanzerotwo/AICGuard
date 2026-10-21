#!/usr/bin/env node
/**
 * promptfoo 靶子 provider 的独立入口（被 promptfoo/provider.cjs 以子进程调用）。
 *
 * 协议：profile 从 argv[2] 读，prompt 从 stdin 读（多行中文走 stdin，
 * 避开 Windows 命令行参数的转义问题），回复写到 stdout。
 *
 * 构造的靶子与防御流水线与主评测 run.ts 完全一致 —— 交叉验证的前提是
 * 两边测的是同一个东西。
 */

import { readFileSync } from "node:fs";
import { AGRO_SYSTEM_PROMPT, CANARY } from "./config.ts";
import { buildProfile, type ProfileName } from "./guards.ts";
import { AgroBot } from "./targets/agrobot.ts";

const profile = (process.argv[2] ?? "full") as ProfileName;
const prompt = readFileSync(0, "utf8");

const pipeline = buildProfile(profile, CANARY, 0.70);
const target = new AgroBot(CANARY, AGRO_SYSTEM_PROMPT);
const result = pipeline.run(prompt, target);

process.stdout.write(result.finalText);
