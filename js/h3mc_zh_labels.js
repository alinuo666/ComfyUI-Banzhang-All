// 💾 H3 续拍存档等节点的参数中文名。
//
// 为什么需要这个文件：参数配置里的 "label"（INPUT_TYPES options）在新版
// ComfyUI 前端里根本不读；官方语言包机制（locales/zh/nodeDefs.json）又
// 被 CustomNodeManager 的 lru_cache 缓存，插件热重载清不掉，必须整进程
// 重启才生效。这个扩展在控件创建那一刻直接把中文名写到 widget.label 上
// ——三条路里最直接的一条，刷新页面即生效，不依赖重启与缓存。
import { app } from "../../scripts/app.js";
// 统一调度中心：本节点的多轮尺寸收敛交给它排队 —— 交互期间自动让路、并带
// 独立错误隔离（详见 bz_ui_scheduler.js 顶部说明）。
import { bzRequestLayout } from "./bz_ui_scheduler.js";

const SAVE_NODE = "MiniMaxH3MotionContextSaveLatent";
// 同名冲突防御后的新入口（第三方包会抢走上边那个名字），两者共用一套中文名。
const ARCHIVE_NODE = "BanZhang_H3_ClipArchive";

const SAVE_LABELS = {
  // 「保存路径」「本片段编号」两个控件已从节点上撤掉（各自只有一个正确
  // 取值，注册层固定成 h3_context/clip + 自动编号）—— 这里不再给它们起
  // 中文名。真要是老节点实例还残留着这两个控件，让它显英文原名，
  // 反而一眼看得出是个已经作废的旋钮。
  latent: "潜空间",
  // 存档总开关（20261017 新增）：内部键保持 archive_enabled 不变 ——
  // 链控/状态读取/互斥脚本都按这个名字取值，改键会连累存量和老工作流；
  // 只在显示层把控件名换成中文。
  archive_enabled: "启用存档",
};

const LABELS = {
  [SAVE_NODE]: SAVE_LABELS,
  [ARCHIVE_NODE]: SAVE_LABELS,
  MiniMaxH3MotionContextLoadLatent: {
    latent_path: "存档路径",
    clip_index: "续写自第几段",
  },
  BanZhangH3DriftControl: {
    prefix_steps: "前缀步数",
  },
};

app.registerExtension({
  name: "Banzhang.H3ZhLabels",
  beforeRegisterNodeDef(nodeType, nodeData) {
    const map = LABELS[nodeData?.name];
    if (map) {
      const applyZh = function () {
        for (const w of this.widgets || []) {
          const zh = map[w.name];
          if (zh) w.label = zh;
        }
        // 输入槽位名：后端 / locales 可能还带着旧括号「（接导演台任一空闲口）」，
        // 这里统一压平成纯中文名 —— 刷新页面即生效，不用等 locales 缓存随进程重启。
        for (const inp of this.inputs || []) {
          if (inp && inp.name === "顺序锚") inp.label = "顺序锚";
        }
      };

      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = onNodeCreated?.apply(this, arguments);
        applyZh.call(this);
        return r;
      };

      // 加载已保存工作流走 onConfigure：画布上**已有**的存档节点不会重新走
      // onNodeCreated，必须在这里再刷一次，否则它的控件名会一直停在英文
      // 内部键 archive_enabled 上 —— 这正是「重启了还是英文名」的根因。
      const onConfigureZh = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const r = onConfigureZh?.apply(this, arguments);
        applyZh.call(this);
        return r;
      };
    }

    // 💾 续拍存档：顶部状态信息面板已于 2026-10-12 移除，节点现在没有任何
    // 控件，只剩「潜空间画布 / 顺序锚」两个输入口和「潜空间」输出口。
    // 老工作流存档里的节点高度是当年被面板撑到 220 的（节点尺寸随工作流
    // 存档保存），不主动重算就会永久留一大截空白框体 —— 加载后按纯端口
    // 自然高度收回，宽度不动（用户可能手动拉宽过）。
    if (nodeData?.name === SAVE_NODE || nodeData?.name === ARCHIVE_NODE) {
      const shrinkToPorts = function () {
        const node = this;
        // 还有可见控件（极老版本残留的旋钮）就不收敛，避免把控件裁掉。
        if ((node.widgets || []).some((w) => !w.hidden)) return;
        try {
          const cs = node.computeSize?.();
          const targetH = Math.ceil((cs?.[1] || 0) + 4);
          const curH = node.size?.[1] || 0;
          // 高度封顶（20261017）：computeSize 偶尔会给出离谱的值，节点一旦被
          // 设成几万像素高，LiteGraph 每帧照画不误 —— 画布重绘吃满内存、主线程
          // 被拖死，直接表现就是「新拖出来的节点粘在鼠标上点不下去」。纯端口
          // 节点的自然高度远低于上限，封顶不影响正常收缩；已经被撑爆的旧节点
          // 也会在这里被强制拉回来。
          const MAX_H = 480;
          // 40 是异常值兜底：纯端口节点自然高度本就远大于它。
          let wantH = null;
          if (targetH > 40 && targetH <= MAX_H) {
            wantH = targetH;
          } else if (curH > MAX_H) {
            wantH = MAX_H;
          }
          if (wantH !== null && Math.abs(curH - wantH) > 2) {
            node.setSize?.([node.size?.[0] || 340, wantH]);
            node.setDirtyCanvas?.(true, true);
          }
        } catch (e) { /* 布局算不出就维持原样，不强推 */ }
      };

      const prevCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = prevCreated?.apply(this, arguments);
        shrinkToPorts.call(this);
        return r;
      };

      const prevConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const r = prevConfigure?.apply(this, arguments);
        const node = this;
        // v2 布局/字体晚就绪：多轮重算，把存档旧高度收干净。
        // 每一轮都过一遍统一调度中心：拖拽/放下节点时它会自动让路（不再跟
        // mouseup 抢主线程），算崩了也只是这一轮跳过，不拖垮整张画布。
        const once = () => bzRequestLayout(node, () => shrinkToPorts.call(node));
        once();
        requestAnimationFrame(once);
        setTimeout(once, 60);
        setTimeout(once, 300);
        return r;
      };
    }
  },
});
