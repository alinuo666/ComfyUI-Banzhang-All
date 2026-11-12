/* ============================================================
 * 通用界面零件（导演台 / 媒体架 / 文案台 共用）
 * ------------------------------------------------------------
 * el / 自定义下拉 / 拖放判定 / 素材预览与上传。都是与业务无关的零件，
 * 三个节点各写一份迟早会长歪，所以收在一处。
 * ============================================================ */

import { api } from "../../scripts/api.js";
import { relFromEvent, hasRef } from "./bz_media_ref.js";
import { ASSET_SUBFOLDER, EXT_KIND, assetDirOf, castSlotFiles } from "./csglide_cast_core.js";

/* 认素材类型：先看浏览器给的 MIME，MIME 缺失（系统没注册该扩展名）再按扩展名
   表回落。dragKind 里零拷贝引用只有文件名，也靠它认类型。 */
function fileKind(f) {
  const t = f?.type || "";
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  const name = (f?.name || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return EXT_KIND[ext] || "";
}

export function dragKind(e) {
  const dt = e.dataTransfer;
  if (!dt) return null;
  /* 媒体加载器拖来的引用：drop 阶段才有值，dragover 阶段只认类型存在 */
  const ref = relFromEvent(e);
  if (ref) return fileKind({ name: ref }) || "";
  if (hasRef(e)) return "";
  const types = Array.from(dt.types || []);
  if (!types.includes("Files")) return null;
  const item = Array.from(dt.items || []).find((i) => i.kind === "file");
  const mime = item?.type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "";              /* a file, but the browser will not say what kind */
}

/* A dropdown that looks like the rest of the panel rather than an OS combo.
 * Same surface as the <select> it replaces: .value, .onchange, .disabled.
 * 菜单挂在 document.body 上（不在节点内），拿不到节点的局部 CSS 变量，所以
 * 主色靠 data-mode 传递：mode 由调用方给，缺省沿用导演台的家族标记。 */
export function makeSelect(node, titleAttr, mode) {
  const btn = el("button", "gcast-select");
  btn.type = "button";
  if (titleAttr) btn.title = titleAttr;
  const lbl = el("span", "lbl");
  btn.append(lbl, el("span", "caret", "\u25BE"));

  let opts = [], value = null, onchange = null, disabled = false, menu = null;
  let dismissing = false;      /* a press outside is waiting for its pointerup */

  const paint = () => {
    const o = opts.find((o) => o.value === value);
    lbl.textContent = o ? o.label : "";
    btn.setAttribute("aria-disabled", String(disabled));
  };

  const close = () => {
    dismissing = false;
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", close, true);
  };
  /* Dismiss on pointerUP, never on pointerdown. Removing the menu while the
   * button is still down means the matching pointerup lands on nothing, and
   * the v2 canvas is left believing a drag is in progress -- the graph then
   * pans with the mouse until the next press. Same reason items select on
   * click; this is the path that press missed. */
  const onOutside = (e) => {
    if (!menu || menu.contains(e.target) || dismissing) return;
    dismissing = true;
    const done = () => {
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
      dismissing = false;
      close();
    };
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };

  const open = () => {
    close();
    menu = el("div", "gcast-menu");
    menu.dataset.mode = mode || node?.h3ui?.mode
      || document.querySelector(".gcast")?.dataset.mode || "";
    let lastGroup = null;
    opts.forEach((o) => {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group;
        menu.append(el("div", "grp", o.group));
      }
      const b = el("button", null);
      b.type = "button";
      b.append(el("span", null, o.label));
      if (o.note) b.append(el("span", "note", o.note));
      b.setAttribute("aria-selected", String(o.value === value));
      /* Select on CLICK, not pointerdown. Removing the menu on pointerdown
       * means the matching pointerup lands on nothing, and the v2 canvas is
       * left believing a drag is still in progress. */
      b.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        close();
        if (o.value === value) return;
        value = o.value;
        paint();
        onchange?.(value);
      });
      menu.append(b);
    });
    document.body.append(menu);

    const r = btn.getBoundingClientRect();
    menu.style.minWidth = Math.max(r.width, 170) + "px";
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    menu.style.top = (r.bottom + 4 + h > window.innerHeight - 8
      ? Math.max(6, r.top - h - 4)
      : r.bottom + 4) + "px";

    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", close, true);
  };

  btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (disabled) return;
    menu ? close() : open();
  });

  return {
    el: btn,
    setOptions(list) { opts = list || []; paint(); },
    get value() { return value; },
    set value(v) { value = v; paint(); },
    set disabled(v) { disabled = !!v; paint(); },
    set onchange(fn) { onchange = fn; },
    close,
  };
}

export const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

export function viewURL(file) {
  if (!file) return "";
  const i = file.lastIndexOf("/");
  const sub = i >= 0 ? file.slice(0, i) : "";
  const name = i >= 0 ? file.slice(i + 1) : file;
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}&type=input`);
}

/* subfolder 由调用方给（导演台 / 媒体架都按工程落目录，见 csglide_cast_core.js
   的 assetDirOf）；不传才退回全局 cglide 根 —— 与旧版逐字一致，老调用点不受影响。

   overwrite=true：同名直接覆盖（server.py 的 store_image_upload 认这个参数）。
   不传的话内容不同时它把文件改名成「名 (1).ext」落第二份——正是「素材名后面
   自动多出编号」的根因。素材名是身份：同工程再导入同名就该换新内容、名字不变。 */
export async function uploadFile(file, subfolder) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("subfolder", subfolder || ASSET_SUBFOLDER);
  body.append("overwrite", "true");
  body.append("type", "input");
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  if (res.status !== 200) throw new Error(`上传失败 (${res.status})`);
  const d = await res.json();
  /* 兜底拼 subfolder：个别 ComfyUI 版本的 /upload/image 响应不带 subfolder
     字段（或为空），只回填裸文件名会让 viewURL 丢掉子目录 → 之后每次渲染
     /view 都 404，缩略图永远是裂图。请求里明确传了目录，成功就按它算。 */
  const sub = d.subfolder || subfolder || ASSET_SUBFOLDER;
  return sub ? `${sub}/${d.name}` : d.name;
}

/* 导演台：素材落本工程子目录 input/cglide/<片名>/。
   同名且本工程有槽位正在用它 → 落回那个目录原地覆盖（老存档在根上就回根）。
   st 是面板状态（ui.st），片名取 st.chain.name。 */
export function castAssetDir(st, fileName) {
  return assetDirOf(castSlotFiles(st), (st && st.chain && st.chain.name) || "", fileName);
}

export function pickFile(accept, multiple) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    if (multiple) inp.multiple = true;
    inp.onchange = () => {
      const list = inp.files ? Array.from(inp.files) : [];
      resolve(multiple ? list : (list[0] || null));
    };
    inp.click();
  });
}

export function probeDuration(url, isVideo) {
  return new Promise((resolve) => {
    const m = document.createElement(isVideo ? "video" : "audio");
    m.preload = "metadata";
    m.onloadedmetadata = () => resolve(Number.isFinite(m.duration) ? m.duration : 0);
    m.onerror = () => resolve(0);
    m.src = url;
  });
}
