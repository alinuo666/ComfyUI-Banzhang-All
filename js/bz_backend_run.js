/* 后端权威渲染状态（20261106 v2 阶段 ⑤）
 * ------------------------------------------------------------
 * 浏览器 renderAll 的 for 循环保留（按段编译 prompt 只能在前端做），
 * 但「跑到第几段 / 哪段成功 / 刷新后从哪继续」交给后端 SegmentRunner，
 * 取代 localStorage 心跳与司机/观察者选举。
 *
 * 默认关闭；控制台执行 window.__bzBackendRun = true 后启用。
 * 后端路由不可用时全部返回 null，调用方自动退回原浏览器循环，绝不拦出片。
 */
const BASE = "/cglide/chain/run_segments";

async function call(path, body) {
  try {
    const opt = body === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(BASE + path, opt);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

export const backendRun = {
  enabled() {
    return typeof window !== "undefined" && window.__bzBackendRun === true;
  },
  async start(name, clips, runId) {
    if (!this.enabled()) return null;
    return call("/start", { name, clips, run_id: runId || null });
  },
  async submit(runId, clip, promptId) {
    if (!this.enabled() || !runId) return null;
    return call("/submit", { run_id: runId, clip, prompt_id: promptId || null });
  },
  async done(runId, clip, ok, receipt) {
    if (!this.enabled() || !runId) return null;
    return call("/done", { run_id: runId, clip, ok: !!ok, receipt: receipt || null });
  },
  async status(runId) {
    if (!runId) return null;
    return call("/status?run_id=" + encodeURIComponent(runId));
  },
  async stop(runId) {
    if (!runId) return null;
    return call("/stop", { run_id: runId });
  },
};
