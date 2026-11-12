// 🎬 文本编码器投影 —— 端口与参数的中文显示名。
//
// 为什么不直接把 INPUT_TYPES 的键写成中文：`clip` 这个键名是下游节点取值用
// 的（clip 口、clip 类型），改了会连累存量工作流和所有按名字取值的代码。
// 显示层用两条路解决：
//   · 端口 → slot.label（绘制时优先级最高，压过框架自带的本地化）
//   · 控件 → widget.label（INPUT_TYPES options 里的 label 在新前端不读）
// 两处都要在 onNodeCreated 和 onConfigure 各钉一遍：从存档恢复时 configure
// 会按节点定义重建 slot 对象，新对象不带我们钉过的 label，端口就回退成裸的
// "clip"（框架还会把它本地化成「剪辑」，更看不懂）。
import { app } from "../../scripts/app.js";

const WIDGET_ZH = {
  encoder: "编码器模型",
  encoder_type: "编码器类型",
  projection: "投影矩阵",
};

const SLOT_ZH = {
  clip: "文本编码器",
};

// 键是注册时用的类名。
const NODES = {
  BanzhangClipProjLoader: true,
};

function applyZh(node) {
  for (const w of node.widgets || []) {
    const zh = WIDGET_ZH[w.name];
    if (zh) w.label = zh;
  }
  for (const slot of [...(node.inputs || []), ...(node.outputs || [])]) {
    if (!slot) continue;
    const key = (slot.name || slot.localized_name || "").toLowerCase();
    const zh = SLOT_ZH[key];
    if (zh) slot.label = zh;
  }
}

app.registerExtension({
  name: "Banzhang.ClipProjZh",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODES[nodeData?.name]) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      applyZh(this);
      return r;
    };

    const onConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigured?.apply(this, arguments);
      applyZh(this);
      // configure 之后前端还会按自己的布局重排一次，那时可能又换掉 slot
      // 对象，所以下一帧补钉一次。只补一帧，不做轮询。
      requestAnimationFrame(() => applyZh(this));
      return r;
    };

    // 新连线会触发 slot 重建，顺手再钉一遍。
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      applyZh(this);
      return r;
    };
  },
});
