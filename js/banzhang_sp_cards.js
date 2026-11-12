// 卡片网格：资产/核心帧卡片。
// 视觉规范（V3 单页流水线）：图为主体；状态用左下角小点+遮罩表达；
// 操作（锁定/重生/预览）hover 才浮现；锁定=琥珀细框+降饱和+锁角标；
// 失败=红框+图面重试按钮+错误一行；核心帧底部 @图片N 参考条三态。

export function viewUrl(file, subfolder) {
    const q = new URLSearchParams({ filename: file, type: "output" });
    if (subfolder) q.set("subfolder", subfolder);
    return `/view?${q.toString()}`;
}

// 1.5px 描边线性图标，风格统一
const I = {
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
    rerun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v5.5M12 16.5h.01"/></svg>',
};

function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

// 悬浮操作按钮：小图标，默认深底，hover 蓝底
function hbtn(icon, title, onClick) {
    const b = el("button", "spv-hbtn");
    b.innerHTML = icon;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
}

// 核心帧参考资产小条：ok 小图+#N 角标 / failed 红框叹号 / 其他 虚线占位
function refStrip(refs, assetIndex, onPreview, assetList) {
    const wrap = el("div", "spv-refs");
    const tag = el("span", "spv-ref-tag");
    if (!refs.length) {
        tag.textContent = "无参考·文生图";
        tag.classList.add("spv-ref-none");
        wrap.appendChild(tag);
        return wrap;
    }
    tag.textContent = "参考";
    wrap.appendChild(tag);
    for (const r of refs) {
        const a = assetIndex[r];
        const box = el("span", "spv-ref");
        if (a && a.file && (a.status === "ok" || a.status === "locked")) {
            box.title = `${r} ${a.name}`;
            const im = el("img");
            im.src = viewUrl(a.file, a.subfolder);
            im.loading = "lazy";
            im.onclick = (e) => { e.stopPropagation(); onPreview(a, assetList); };
            const no = el("span", "spv-ref-no");
            no.textContent = r.replace("@图片", "#");
            box.append(im, no);
        } else if (a && a.status === "failed") {
            box.classList.add("spv-ref-miss");
            box.title = `${r} ${a.name} 生成失败`;
            box.innerHTML = I.warn;
        } else {
            box.classList.add("spv-ref-wait");
            box.title = a ? `${r} ${a.name} 尚未生成` : `${r} 未找到`;
        }
        wrap.appendChild(box);
    }
    return wrap;
}

// 缩略图区：有图显图（失败降亮度），无图按类型显占位
function thumbArea(kind, it) {
    const thumb = el("div", "spv-thumb");
    const hasFile = !!it.file;
    if (hasFile) {
        if (it.status === "failed") {
            const im = el("img");
            im.src = viewUrl(it.file, it.subfolder);
            im.style.cssText = "filter:brightness(.55) saturate(.5)";
            thumb.appendChild(im);
        } else {
            const im = el("img");
            im.src = viewUrl(it.file, it.subfolder);
            im.loading = "lazy";
            thumb.appendChild(im);
        }
    } else {
        const ph = el("div", "spv-ph");
        ph.innerHTML = (kind === "asset" ? I.image : I.film) +
            `<span>${kind === "asset" ? (it.type || "资产") : it.name}</span>`;
        thumb.appendChild(ph);
    }
    return thumb;
}

export function renderCards(kind, items, assetIndex, handlers, assetList) {
    if (!items.length) {
        const empty = el("div", "spv-empty");
        empty.textContent = kind === "asset"
            ? "还没有资产，把含「## @图片N」的剧本/色板文件拖进来"
            : "还没有核心帧，把含「<<<核心帧提示词>>>」的剧本文件拖进来";
        return empty;
    }
    const grid = el("div", "spv-grid");
    const clickable = (it) => it.file && (it.status === "ok" || it.status === "locked");

    for (const it of items) {
        const card = el("div", "spv-card spv-" + it.status);
        const thumb = thumbArea(kind, it);

        // 失败：图面正中重试圆钮
        if (it.status === "failed") {
            const fab = el("button", "spv-retry-fab");
            fab.innerHTML = I.rerun;
            fab.title = "重试这一张";
            fab.onclick = (e) => { e.stopPropagation(); handlers.onRerun(kind, it); };
            thumb.appendChild(fab);
        }

        // 左下角状态点（ok/locked/failed/running）
        if (it.status !== "pending") {
            const dot = el("span", "spv-sdot spv-sdot-" + it.status);
            dot.title = { running: "生成中", ok: "完成", failed: "失败", locked: "已锁定" }[it.status] || "";
            thumb.appendChild(dot);
        }

        // 锁定角标（常驻）
        if (it.status === "locked") {
            const lb = el("span", "spv-lock-badge");
            lb.innerHTML = I.lock;
            thumb.appendChild(lb);
        }

        // hover 操作条：生成中不显示，失败时让位给图面重试钮
        if (it.status !== "running") {
            const bar = el("div", "spv-hoverbar");
            const isLocked = it.status === "locked";
            bar.appendChild(hbtn(isLocked ? I.unlock : I.lock,
                isLocked ? "解锁（恢复参与整批运行）" : "锁定（整批运行时跳过）",
                () => handlers.onLock(kind, it)));
            bar.appendChild(hbtn(I.rerun, "重生（换新种子）",
                () => handlers.onRerun(kind, it)));
            if (clickable(it)) {
                bar.appendChild(hbtn(I.zoom, "放大预览",
                    () => handlers.onPreview(it, items)));
            }
            thumb.appendChild(bar);
        }

        // 生成中遮罩
        if (it.status === "running") {
            const mask = el("div", "spv-run-mask");
            mask.appendChild(el("span", "spv-spinner"));
            thumb.appendChild(mask);
        }

        // 点击缩略图放大（仅已完成）
        thumb.onclick = () => { if (clickable(it)) handlers.onPreview(it, items); };
        card.appendChild(thumb);

        // 文字信息
        const meta = el("div", "spv-meta");
        const nm = el("div", "spv-nm");
        nm.textContent = (kind === "asset" ? it.id + " " : "") + it.name;
        nm.title = nm.textContent;
        meta.appendChild(nm);

        if (kind === "asset") {
            const sub = el("div", "spv-sub");
            const ty = el("span", "spv-ty");
            ty.textContent = it.type || "资产";
            sub.appendChild(ty);
            if (it.seed != null && it.seed !== "") {
                const sd = el("span", "spv-seed");
                sd.textContent = "种子 " + it.seed;
                sub.appendChild(sd);
            }
            meta.appendChild(sub);
        } else {
            meta.appendChild(refStrip(it.refs || [], assetIndex,
                                      handlers.onPreview, assetList));
        }

        if (it.status === "failed" && it.error) {
            const err = el("div", "spv-err");
            err.textContent = it.error;
            err.title = it.error;
            meta.appendChild(err);
        }
        card.appendChild(meta);
        grid.appendChild(card);
    }
    return grid;
}
