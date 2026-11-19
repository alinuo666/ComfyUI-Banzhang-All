/* 分镜轨锚交互（20261119）：缩略图＋时间标签＋×，拖锚改时间点，点图大预览。
   ctx 由主模块注入：pxOf/fmt/imgUrl/ppf/clampAt/del(ent)/save()。 */

export function anchorEl(ent, ctx) {
  const el = document.createElement("div");
  el.className = "bzsb-anchor";
  el.style.left = ctx.pxOf(ent.at) + "px";
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

/* 拖锚改时间点：pointer capture 全程跟手，松手才落盘（一次 POST）。 */
function dragStart(e, el, ent, atEl, ctx) {
  if (e.button !== 0 || e.target.closest(".bzsb-x")) return;
  const k = ctx.ppf();
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, a0 = ent.at;
  el.__bzMoved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const d = Math.round((ev.clientX - x0) / k);
    if (d) el.__bzMoved = true;
    ent.at = ctx.clampAt(a0 + d);
    el.style.left = ctx.pxOf(ent.at) + "px";
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
  im.src = ctx.imgUrl(ent.file);
  const lb = document.createElement("div");
  lb.textContent = ctx.fmt(ent.at) + "　" + ent.file;
  ov.append(im, lb);
  ov.addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
}