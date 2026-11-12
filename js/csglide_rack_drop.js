/* ============================================================
 * H3 媒体架 — 节点级拖入
 * ------------------------------------------------------------
 * 落在面板空白处（不在某一格里）的文件按类型路由到第一个空位：
 * 落格，不搬动已有素材。

 * 拒绝原因必须说出来。识别不出类型的文件此前被静默丢弃（if (k) 为假直接
 * continue）：用户只看到「拖进来没反应」，无从判断是格式不支持还是程序坏了。
 * 分两档说清：①认得出、是图片、但后端 PIL 读不了的（HEIC/SVG…）→ 转格式；
 * ②根本不认识的 → 不支持。两条并作一条 toast——共用一个提示条，分两次调用
 * 会互相覆盖，只剩下后说的那句。
 * ============================================================ */
import { badImageKind } from "./csglide_cast.js";
import { hasRef, relFromEvent } from "./bz_media_ref.js";
import { MAX_SLOTS, fileKind } from "./csglide_rack_core.js";

export function installDrop(ui) {
  /* 一次性给 n 张图片分配落格下标（同步，调一次占 n 格）。

     为什么必须**先分配再上传**而不能边传边找空位：上传是 await，两个并发
     任务都去 findIndex(空槽) 会拿到同一个下标，后完成的把先完成的盖掉 ——
     表现就是「明明拖了 100 张，少了好几张」。预分配把这件事变成同步的、
     不可能撞车的一步。

     两个坑，缺一个就会「拖 100 张少好几张」：

     ① 不能边传边找空位：上传是 await，并发的两个任务 findIndex(空槽) 会拿到
        同一个下标，后完成的盖掉先完成的。
     ② 不能在循环里一次要一个：分配出去的槽位在**上传完成、file 写进去之前**
        仍然是空的，下一次 allocImageSlots(1) 又会命中它 —— 30 张图全挤在第 0
        格。所以批量必须**一次把 n 个全要齐**，不能拆成 n 次调用。
        （自测 _selftest_rack_batch.mjs 的 1.5 条钉的就是这个。）

     一律追加在**末尾**（20261020），不复用中间被清空的槽位：槽位编号就是
     @图片N 的 N，往中间的洞里插会让剧本里已写好的 @图片3 指向另一张图，
     而且不报错。要换掉某一格就用「×」清掉再拖，或按住 Shift 拖上去。 */
  function allocImageSlots(n) {
    const arr = ui.st.slots.images;
    const out = [];
    /* 末尾「＋ 添加」点出来的空壳先收掉再 push —— 否则顺序会变成
       「空壳、新图」中间夹洞。收掉的都是空槽位，没有内容可丢。 */
    while (arr.length && !arr[arr.length - 1].file) arr.pop();
    while (out.length < n && arr.length < MAX_SLOTS) {
      arr.push({});
      out.push(arr.length - 1);
    }
    return out;
  }
  ui.allocImageSlots = allocImageSlots;

  /* 按类型落到第一个空位（落格，不搬动已有素材）。
     index 给了就用它（批量预分配好的），不给才现找（单张拖入）。 */
  async function routeToFree(kind, file, index) {
    if (kind === "image") {
      const at = index != null ? index : allocImageSlots(1)[0];
      if (at != null) await ui.assignImage(at, file);
      else ui.toast(`图片槽位已达上限 ${MAX_SLOTS} 个，请先清理再导入`, true);
      return;
    }
    const k = kind === "video" ? "videos" : "audios";
    /* 卡片列表 / 网格 / 添加格都在 cards 分区内部，这里只按 kind 要结果 */
    let c = ui.freeMediaSlot(k);
    if (!c) c = ui.appendMedia(k);   // 满则返回 null
    if (!c) {
      ui.toast(`${kind === "video" ? "视频" : "音频"}槽位已达上限 ${MAX_SLOTS} 个，请先清理再导入`, true);
      return;
    }
    await c.fill(file);
  }
  ui.routeToFree = routeToFree;

  /* 并发跑但有上限：100 个请求一起发会把服务器和浏览器连接数都打满，反而更慢
     （而且 ComfyUI 是单进程，上传是串到它那条事件循环上的）。4~6 条实测够。 */
  async function mapLimit(list, n, fn) {
    let i = 0;
    const workers = [];
    for (let w = 0; w < Math.min(n, list.length); w++) {
      workers.push((async () => {
        while (i < list.length) {
          const k = i++;
          try { await fn(list[k], k); } catch (_) { /* 单个失败不拖累整批 */ }
        }
      })());
    }
    await Promise.all(workers);
  }

  ui.root.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.items].some((it) => it.kind === "file") && !hasRef(e)) return;
    e.preventDefault();
    ui.root.classList.add("drop-active");
  });
  ui.root.addEventListener("dragleave", (e) => {
    if (!ui.root.contains(e.relatedTarget)) ui.root.classList.remove("drop-active");
  });
  ui.root.addEventListener("drop", async (e) => {
    if (ui.isReordering?.()) return;          /* 内部换位拖拽不在此处理 */
    ui.root.classList.remove("drop-active");
    /* 已在 input 目录里的素材：直接记引用，不进上传通道 */
    const ref = relFromEvent(e);
    if (ref) {
      e.preventDefault(); e.stopPropagation();
      const k = fileKind({ name: ref });
      if (k) await routeToFree(k, ref);
      else ui.toast(`不支持的格式：${ref}`, true);
      return;
    }
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault(); e.stopPropagation();
    const bads = [], rejected = [], overflow = [];
    const imgFiles = [], mediaJobs = [];

    /* 第一遍只做**同步**的挑拣，一个 await 都没有 —— 分配一旦夹在 await 之间
       就会有并发撞车（见 allocImageSlots）。 */
    for (const f of e.dataTransfer.files) {
      const k = fileKind(f);
      if (k === "image") { imgFiles.push(f); continue; }
      if (k) { mediaJobs.push({ k, f }); continue; }
      const b = badImageKind(f);
      if (b) bads.push(`${f.name}（${b}）`);
      else rejected.push(f.name);
    }

    /* 第二遍才分配：一次性把这一批图片的下标全要齐（不能循环一次要一个）。 */
    const idx = allocImageSlots(imgFiles.length);
    const imgJobs = imgFiles.map((f, k) => ({ at: idx[k], f }));
    for (let k = idx.length; k < imgFiles.length; k++) overflow.push(imgFiles[k].name);

    /* 第二遍才动网络。整批包在 beginBatch/endBatch 里：commit 的重活（深拷贝、
       全量序列化、全画布重绘、广播）末尾只做一次，不是每张一次。

       视频/音频仍串行：ui.freeMediaSlot 是「找第一个没 file 的卡片」的纯查询、
       不占座，并发下两个任务会拿到同一张卡互相覆盖（图片那条路已经用预分配
       绕开了，卡片区改动大、且一次拖几十个视频不常见，串行足够）。 */
    ui.beginBatch();
    try {
      await mapLimit(imgJobs, 6, ({ at, f }) => ui.assignImage(at, f));
      for (const { k, f } of mediaJobs) await routeToFree(k, f);
    } finally {
      ui.endBatch();
    }

    /* 汇总一次说清，不要每张弹一条 —— 100 张里超限 36 张时，36 条 toast
       只会互相覆盖，用户最后只看到一条，还以为素材凭空没了。

       顺便给个收尾确认：卡片是逐个出现的，但没有「到底进了多少」的交代，
       全都在上限内时更是**一声不响**。少量导入不打扰（拖 2 张还弹提示很烦），
       10 个以上才报数。 */
    const got = imgJobs.length + mediaJobs.length;
    const parts = [];
    if (got >= 10) parts.push(`已导入 ${got} 个素材`);
    if (overflow.length) {
      parts.push(`图片槽位上限 ${MAX_SLOTS}，${overflow.length} 张没导入：`
        + overflow.slice(0, 5).join("、") + (overflow.length > 5 ? " …" : ""));
    }
    if (bads.length) parts.push(`无法作为参考图、请先转成 PNG/JPG：${bads.join("、")}`);
    if (rejected.length) parts.push(`不支持的格式：${rejected.join("、")}`);
    if (parts.length) {
      /* 只有真出问题才标成错误样式；"已导入 N 个"是报喜，不该是红的。 */
      ui.toast(parts.join("；"), overflow.length + bads.length + rejected.length > 0);
    }
  });
}
