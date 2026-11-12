// 旧工作流兼容（2026-10-13 端口调整）：
//   1) 🎞️ 插帧·RIFE/EMA：输入端口顺序由「视频/图像」改为「图像/视频」（0=图像, 1=视频）；
//   2) 🔍 RTX 超分降噪 / 🎞️ RIFE：删除「状态」(STRING) 输出端口；
//   3) RTX 超分降噪新增「视频」输出后输出位变为 0=图像、1=视频（旧版视频口在 2、状态口在 1）。
// 旧存档按槽位索引恢复连线，这里在 graph.configure 之前直接修正序列化数据，
// 老工作流无需手动重连、状态线也不会错挂到视频口。
//
// 幂等原则：只有「真正识别为旧格式」的节点才做迁移；已经是新格式的存档（视频口在槽 1）
// 绝不能再按槽位删线——否则刷新一次后新视频线会被误删。
import { app } from "../../scripts/app.js";

const RIFE_TYPE = "BanZhang_RIFE_Interpolation";
const RTX_SR_TYPE = "BanZhang_RTX_SuperResolution";

function isStatusSlot(slot) {
  return !!slot && String(slot.type || "").includes("STRING");
}

app.registerExtension({
  name: "banzhang.video_port_migrate",
  beforeConfigureGraph(data) {
    if (!data || !Array.isArray(data.nodes)) return;
    try {
      // 状态口（STRING）连出的、需要删除的线
      const dropLinkIds = new Set();
      // 真正经历过「RTX 三输出→两输出」的节点：视频口 2→1
      const rtxSlotRemapIds = new Set();
      // 真正经历过「RIFE 输入口交换」的节点：输入槽 0↔1
      const rifeSwapIds = new Set();

      for (const node of data.nodes) {
        if (!node) continue;

        // ---- RIFE：输入口旧顺序（0=视频, 1=图像）→ 新顺序（0=图像, 1=视频）
        if (node.type === RIFE_TYPE && Array.isArray(node.inputs)) {
          const ins = node.inputs;
          if (String(ins[0]?.type || "") === "VIDEO" &&
              String(ins[1]?.type || "") === "IMAGE") {
            const tmp = ins[0];
            ins[0] = ins[1];
            ins[1] = tmp;
            rifeSwapIds.add(String(node.id));
          }
        }

        if (!Array.isArray(node.outputs)) continue;
        const outs = node.outputs;

        // ---- RIFE：旧输出 0=视频、1=状态 → 只留视频
        if (node.type === RIFE_TYPE && outs.length >= 2 && isStatusSlot(outs[1])) {
          for (const id of outs[1].links || []) dropLinkIds.add(id);
          node.outputs = [outs[0]];
        }

        // ---- RTX：删状态口；带视频口的版本（0=图像,1=状态,2=视频）→（0=图像,1=视频）
        if (node.type === RTX_SR_TYPE) {
          if (outs.length === 3 && isStatusSlot(outs[1]) &&
              String(outs[2]?.type || "") === "VIDEO") {
            for (const id of outs[1].links || []) dropLinkIds.add(id);
            node.outputs = [outs[0], outs[2]];
            rtxSlotRemapIds.add(String(node.id));
          } else if (outs.length === 2 && isStatusSlot(outs[1])) {
            // 更早的版本（0=图像,1=状态），只保留图像
            for (const id of outs[1].links || []) dropLinkIds.add(id);
            node.outputs = [outs[0]];
          }
        }
      }

      // ---- 全局连线：[id, origin_id, origin_slot, target_id, target_slot, type]
      if (Array.isArray(data.links)) {
        data.links = data.links.filter((link) => {
          if (!Array.isArray(link)) return true;
          const linkId = link[0];
          // 状态口连出的线：只删前面按「槽位实际类型」登记过的
          if (dropLinkIds.has(linkId)) return false;

          // 仅对真正经历过「三输出→两输出」迁移的 RTX 节点：视频口槽位 2→1
          if (rtxSlotRemapIds.has(String(link[1])) && link[2] === 2) {
            link[2] = 1;
          }

          // 仅对真正经历过输入口交换的 RIFE 节点：旧图像口槽1→槽0、旧视频口槽0→槽1
          if (rifeSwapIds.has(String(link[3]))) {
            if (link[4] === 1) link[4] = 0;
            else if (link[4] === 0) link[4] = 1;
          }
          return true;
        });
      }

      // ---- 清掉目标输入槽里对已删连线的引用，避免画出断头线
      if (dropLinkIds.size) {
        for (const node of data.nodes) {
          for (const slot of node.inputs || []) {
            if (slot.link != null && dropLinkIds.has(slot.link)) slot.link = null;
            if (Array.isArray(slot.links)) {
              slot.links = slot.links.filter((id) => !dropLinkIds.has(id));
            }
          }
          for (const slot of node.outputs || []) {
            if (Array.isArray(slot.links)) {
              slot.links = slot.links.filter((id) => !dropLinkIds.has(id));
            }
          }
        }
      }
    } catch (err) {
      console.error("[班长全家桶] 视频节点端口迁移失败：", err);
    }
  },
});
