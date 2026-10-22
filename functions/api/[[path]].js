import snapshot from "./_snapshot.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });

const OFFLINE_MSG =
  "静态演示站为只读模式：实时评测、攻击试探与进化操作需要在本地运行 start.bat（http://127.0.0.1:7777）。";

// 只读接口：返回导出时的真实评测数据快照
export async function onRequestGet({ request, params }) {
  const seg = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  const url = new URL(request.url);

  switch (seg) {
    case "meta":
      return json(snapshot.meta);
    case "runs":
      return json(snapshot.runs);
    case "evolve/history":
      return json(snapshot.evolveHistory);
    case "evolve/candidates":
      return json(snapshot.evolveCandidates);
    case "corpus": {
      const key = url.searchParams.get("file") || "";
      const data = snapshot.corpus[key];
      return data ? json(data) : json({ error: `未知语料文件：${key}` }, 400);
    }
    case "job/status":
    case "eval/status":
      return json({ done: true, code: 1, error: OFFLINE_MSG, offline: true });
    case "candidates/state":
      return json({ mode: "static", pending: 0, approved: 0 });
    default:
      return json({ error: `静态演示站未提供该只读接口：${seg}` }, 404);
  }
}

// 写操作（跑评测、试探、进化）需要本地后端，统一拒绝并给出提示
export async function onRequestPost() {
  return json({ error: OFFLINE_MSG, offline: true }, 503);
}
