import assert from "node:assert/strict";
import { test } from "node:test";
import { runRagCase } from "../src/rag-case.ts";
import { benignEvidenceOf, classifyBenign } from "../src/rag-benign.ts";
import { buildProfile } from "../src/guards.ts";
import type { Target, TransportEvidence } from "../src/types.ts";

test("RAG 良性证据保留每次请求自己的正文和结构化错误，旧记录不补证", () => {
  const transport: TransportEvidence = {
    state: "submitted", requestSha256: "first-sha", requestBytes: 24, attemptId: "first", decodedText: "顶层正文",
    attempts: [
      { n: 1, outcome: "submitted", requestSha256: "first-sha", requestBytes: 24, attemptId: "first",
        decodedText: "第一次实际请求 🧪", responseError: "非法 JSON", responseErrorKind: "json_parse" },
      { n: 2, outcome: "refused", requestSha256: "", requestBytes: 0, attemptId: "",
        decodedText: "", responseError: "预算拒绝", responseErrorKind: "budget" },
      { n: 3, outcome: "refused", requestSha256: "", requestBytes: 0, attemptId: "" },
    ],
  };
  const target: Target = { name: "offline-evidence-fixture", respond: () => ({ text: "", error: "预算中止", latencyMs: 0,
    transport, budgetExhausted: true, budgetStopReason: "exhausted", httpAttempts: 1 }) };
  const spec = { id: "B-evidence", condition: "natural" as const, query: "灌溉压力" };
  const line = runRagCase(spec, [], target, buildProfile("none", "CANARY-OFFLINE", 0.7));
  const evidence = benignEvidenceOf(spec, line, classifyBenign(line), "llm");
  assert.equal(evidence.outcome, "targetError");
  assert.equal(evidence.transport.requestSent, true);
  assert.deepEqual(evidence.transport.evidence?.attempts, transport.attempts,
    "逐次记录应保留各自正文及错误类型，不能用顶层正文补旧记录");
  assert.equal(Object.hasOwn(evidence.transport.evidence!.attempts![2]!, "decodedText"), false);
});
