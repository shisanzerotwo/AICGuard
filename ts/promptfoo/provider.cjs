/**
 * promptfoo 自定义 provider（promptfoo 以 `new Module(options)` 加载，
 * 必须导出构造函数 / 类）。
 *
 * 为什么走子进程而不是直接 import TS 引擎：
 * promptfoo 用自己的 transpiler（jiti/esbuild）加载 provider 文件，
 * 对 .ts 的 strip-only 直跑语义无法保证一致；子进程每次用当前 Node
 * 直接执行 pf-provider.ts，与主评测 run.ts 的执行路径完全相同。
 * prompt 走 stdin，避开 Windows 命令行对多行中文的转义问题。
 *
 * profile / threshold 通过测试变量传入（见 promptfooconfig.yaml 的
 * defaultTest.vars，可用 --var profile=rules 在命令行覆盖）。
 */

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const PROVIDER_ENTRY = resolve(__dirname, "..", "src", "pf-provider.ts");

function runOnce(prompt, vars) {
  const profile = String((vars && vars.profile) || "full");
  // 注意：必须用 spawn 手动写 stdin —— 异步 execFile 不支持 options.input
  // （只有同步版本支持），子进程读 stdin 会永远阻塞（实际踩到的坑）
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [PROVIDER_ENTRY, profile], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`pf-provider 退出码 ${code}：${err.slice(0, 400)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

class AgroBotPipelineProvider {
  constructor(options) {
    options = options || {};
    // 注意：promptfoo 的 ApiProvider 接口里 id 是**方法**，不能写字符串字段；
    // 而 label 必须是**字符串属性**（遥测代码直接 label.toLowerCase()），
    // 所以这里不定义 label 成员，显示名由 yaml 里的 label 字段提供。
    this.providerId = options.id ?? "agrobot-pipeline";
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, options, context) {
    // promptfoo 0.123.1 把测试变量放在第二个参数 options.vars（context 只带 abortSignal）；
    // 兼容旧版写法从 context.vars 取
    const vars = (options && options.vars) || (context && context.vars) || {};
    try {
      const output = await runOnce(prompt, vars);
      return { output };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
}

module.exports = AgroBotPipelineProvider;
