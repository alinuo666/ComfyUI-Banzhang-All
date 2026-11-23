/* 分镜轨锚交互（20261119）：缩略图＋时间标签＋×，拖锚改时间点，点图大预览。
   ctx 由主模块注入：pxOf/fmt/imgUrl/fullUrl/ppf/clampAt/frameAtClientX/del(ent)/save()。
   imgUrl = 48×32 用的缩略图；fullUrl = 大预览用的原图，别混。 */

export function anchorEl(ent, ctx) {
  const el = document.createElement("div");
  el.className = "bzsb-anchor";
  el.style.left = ctx.visLeft(ent.at) + "px";
  el.title = ent.file + " @ " + ctx.fmt(ent.at);
  const img = document.createElement("img");
  img.src = ctx.imgUrl(ent.file);
  img.draggable = false;
  const at = document.createElement("div");
  at.className = "bzsb-at";
  at.textContent = ctx.fmt(ent.at);
  const x = document.createElement("button");
  x.className = "bzsb-x";
  x.textContent = "×";
  x.title = "删除这个锚";
  el.append(img, at, x);
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.del(ent);
    void ctx.save();
  });
  img.addEventListener("click", (e) => {
    if (el.__bzMoved) return;
    e.stopPropagation();
    preview(ent, ctx);
  });
  el.addEventListener("pointerdown", (e) => dragStart(e, el, ent, at, ctx));
  return el;
}

/* 拖锚改时间点：pointer capture 全程跟手，松手才落盘（一次 POST）。

   换算走「绝对反解」，不再是「按下点 + 增量 round」。增量那份 k 是 pointerdown
   当时的每帧像素，拖中途时间轴 refit / 缩放后它就是旧比例，越拖越偏；绝对反解
   每次现取尺子（ctx.frameAtClientX 内部读 ppf），光标压在哪个刻度就是哪一帧。
   剩下的一格一格是整帧量化，模型本身按帧，压不掉。

   grabDx 必须扣掉：不扣的话按下瞬间缩略图左边缘会跳到光标底下（最多偏 48px），
   表现成「点下去先跳一下才跟手」。 */
function dragStart(e, el, ent, atEl, ctx) {
  if (e.button !== 0 || e.target.closest(".bzsb-x")) return;
  if (!ctx.ppf()) return;
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, a0 = ent.at;
  const grabDx = e.clientX - el.getBoundingClientRect().left;
  el.__bzMoved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    /* 死区按像素、不按帧：原先是「帧位移非零」就算拖动，长片 fit 态每帧不到 1px，
       鼠标抖一下这次点击就被判成拖动，把「点图大预览」吞掉。 */
    if (Math.abs(ev.clientX - x0) > 3) el.__bzMoved = true;
    ent.at = ctx.clampAt(ctx.frameAtClientX(ev.clientX - grabDx));
    el.style.left = ctx.visLeft(ent.at) + "px";
    atEl.textContent = ctx.fmt(ent.at);
  };
  const up = (ev) => {
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    setTimeout(() => { el.__bzMoved = false; }, 0);
    if (ent.at !== a0) void ctx.save();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

export function preview(ent, ctx) {
  const ov = document.createElement("div");
  ov.className = "bzsb-preview";
  const im = document.createElement("img");
  im.src = ctx.fullUrl(ent.file);   // 大预览看原图，不走 256 缩略图
  const lb = document.createElement("div");
  lb.textContent = ctx.fmt(ent.at) + "　" + ent.file;
  ov.append(im, lb);
  ov.addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
}