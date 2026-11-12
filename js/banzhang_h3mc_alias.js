// 💾 H3 续拍存档 · 旧工作流节点类型自动迁移
//
// 为什么需要这个文件：班长版已经不再注册上游那个 ID
// （MiniMaxH3MotionContextSaveLatent）—— ComfyUI 的节点表按内部名去重、
// 后加载的覆盖先加载的，而加载顺序用的是不排序的 os.listdir，谁占用这个
// 名字并不由我们决定。老工作流里存着的还是旧 ID，一旦被第三方包占用，
// 打开后拿到的就是原版节点（输出存档路径文本、不走导演台中央编号），
// 表现就是「续拍存档突然不生效」。
// 这里在打开/导入工作流的那一刻把旧类型就地改写成班长版独占 ID，
// 用户全程无感，也不需要重新连线。
import { app } from "../../scripts/app.js";

// 已让出的上游 ID（可能正被第三方包占用）
const LEGACY_TYPE = "MiniMaxH3MotionContextSaveLatent";
// 班长版独占 ID
const ARCHIVE_TYPE = "BanZhang_H3_ClipArchive";

/**
 * 把图里的旧类型节点换成班长版。返回改写数量。
 *
 * 为什么连 widgets_values 一起清空：旧版有「保存路径」「本片段编号」两个
 * 控件，班长版已经撤掉（统一由导演台的段落/take 决定）。前端是按位置把
 * 旧值回填到控件上的，留着它们会把存档开关之类的控件顶歪，所以直接丢掉，
 * 让班长版用自己的默认值。
 */
function rewriteNodes(nodes) {
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const node of nodes) {
    if (!node || node.type !== LEGACY_TYPE) continue;
    node.type = ARCHIVE_TYPE;
    node.widgets_values = [];
    count += 1;
  }
  return count;
}

function migrate(graphData) {
  let total = 0;
  // 工作流文件有两种形态：直接是图，或 { workflow: 图 } 的外壳。
  if (graphData && graphData.nodes) total += rewriteNodes(graphData.nodes);
  const inner = graphData && graphData.workflow;
  if (inner && inner.nodes) total += rewriteNodes(inner.nodes);
  return total;
}

app.registerExtension({
  name: "BanZhang.H3MC.Alias",
  setup() {
    const original = app.loadGraphData.bind(app);
    app.loadGraphData = function (graphData, ...rest) {
      let count = 0;
      try {
        count = migrate(graphData);
      } catch (e) {
        console.error("[班长全家桶] 续拍存档旧节点改写失败：", e);
      }
      if (count > 0) {
        console.log(
          `[班长全家桶] 已把 ${count} 个旧版续拍存档节点切换到班长版（${ARCHIVE_TYPE}）`
        );
      }
      return original(graphData, ...rest);
    };
  },
});
