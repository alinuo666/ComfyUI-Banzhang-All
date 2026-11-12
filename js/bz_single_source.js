/* 三节点单一真源守卫（20261106 v2 阶段 ⑤）
 * ------------------------------------------------------------
 * segment_bindings 已经是段词唯一真值（csglide_store.put_segment_text）。
 * 这里在「落库 flush 完成」和「提交」两个时刻做一次三方副本一致性核对，
 * 漂移时给中文原因，而不是等收片时才发现三处各说各话。
 *
 * 默认关闭；控制台执行 window.__bzSingleSource = true 后启用。
 * 后端不可用时返回 null，调用方按原有行为继续，绝不拦出片。
 */
export async function verifySingleSource(name, clip, snapshots) {
  if (typeof window === "undefined" || window.__bzSingleSource !== true) return null;
  try {
    const res = await fetch("/cglide/store/segment_binding/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, clip, ...(snapshots || {}) }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
