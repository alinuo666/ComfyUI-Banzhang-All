// 专业版贝塞尔曲线编辑器：横轴整段比例 0~1，纵轴 −1~+1 是有符号风格强度
//（−1 = 左侧风格如冻结，+1 = 右侧风格如疾冲，0 = 中性）。
// 前后端共用同一套「锚点 -> 三次贝塞尔段」公式，图形与实际混合权重一致。

export const CURVE_PRESETS = {
    "匀速": [[0, 0.6], [1, 0.6]],
    "快·慢·快": [[0, 0.2], [0.25, 1], [0.5, -0.6], [0.75, 1], [1, 0.2]],
    "慢·快": [[0, -0.6], [0.5, 0], [1, 1]],
    "命中脉冲": [[0, 0], [0.45, 0], [0.5, 1], [0.55, 0], [1, 0]],
    "淡入": [[0, 0], [1, 0.9]],
};
export const DEFAULT_POINTS = () => CURVE_PRESETS["匀速"].map((p) => p.slice());

const X0 = 8, X1 = 312, Y0 = 6, Y1 = 60, YMID = (Y0 + Y1) / 2;
const CSS = `
.bzh3d-curve{width:100%;box-sizing:border-box;padding:2px 0 4px}
.bzh3d-curve svg{display:block;width:100%;height:74px;background:#1a1a1e;border:1px solid #3a3d45;border-radius:6px;cursor:crosshair;touch-action:none}
.bzh3d-curve .bzh3d-grid{stroke:#3a3d45;stroke-width:0.5}
.bzh3d-curve .bzh3d-mid{stroke:#6a6a6a;stroke-width:1}
.bzh3d-curve .bzh3d-line{fill:none;stroke:#85b7eb;stroke-width:2;stroke-linecap:round}
.bzh3d-curve .bzh3d-anchor{fill:#e6f1fb;stroke:#185fa5;stroke-width:1.5;cursor:grab}
.bzh3d-curve .bzh3d-tick{fill:#8a8f99;font-size:9px;font-family:inherit}
.bzh3d-curve .bzh3d-presets{display:flex;gap:4px;margin-top:3px}
.bzh3d-curve .bzh3d-preset{flex:1;min-width:0;height:18px;line-height:17px;text-align:center;border:1px solid #3a3d45;border-radius:5px;background:#444441;color:#b5d4f4;font-size:10px;font-family:inherit;cursor:pointer;padding:0;overflow:hidden;white-space:nowrap}
.bzh3d-curve .bzh3d-preset:hover{border-color:#4a9eff;color:#e6f1fb}
.bzh3d-curve .bzh3d-preset.bzh3d-on{background:#633806;border-color:#fac775;color:#faeeda}
`;

function injectCss() {
    if (document.getElementById("bzh3d-curve-style")) return;
    const el = document.createElement("style");
    el.id = "bzh3d-curve-style";
    el.textContent = CSS;
    document.head.appendChild(el);
}

export function bezierSegments(points) {
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i], p1 = points[i + 1];
        const pm = i > 0 ? points[i - 1] : p0;
        const pp = i + 2 < points.length ? points[i + 2] : p1;
        segs.push([p0,
            [p0[0] + (p1[0] - pm[0]) / 6, p0[1] + (p1[1] - pm[1]) / 6],
            [p1[0] - (pp[0] - p0[0]) / 6, p1[1] - (pp[1] - p0[1]) / 6],
            p1]);
    }
    return segs;
}

function px(t) { return X0 + t * (X1 - X0); }
// m=+1 顶、m=0 中线、m=−1 底。
function py(m) { return YMID - m * (YMID - Y0); }

function pathOf(points) {
    const segs = bezierSegments(points);
    if (!segs.length) return "";
    let d = "M" + px(segs[0][0][0]).toFixed(2) + "," + py(segs[0][0][1]).toFixed(2);
    for (const s of segs) {
        d += " C" + px(s[1][0]).toFixed(2) + "," + py(s[1][1]).toFixed(2);
        d += " " + px(s[2][0]).toFixed(2) + "," + py(s[2][1]).toFixed(2);
        d += " " + px(s[3][0]).toFixed(2) + "," + py(s[3][1]).toFixed(2);
    }
    return d;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createCurveEditor(initial, onChange) {
    injectCss();
    const wrap = document.createElement("div");
    wrap.className = "bzh3d-curve";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 320 74");
    wrap.appendChild(svg);
    const presets = document.createElement("div");
    presets.className = "bzh3d-presets";
    wrap.appendChild(presets);

    let points = (initial && initial.length >= 2)
        ? initial.map((p) => [Number(p[0]), Number(p[1])])
        : DEFAULT_POINTS();
    let current = "";
    let drag = -1;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("class", "bzh3d-line");
    const dots = document.createElementNS("http://www.w3.org/2000/svg", "g");

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const v = document.createElementNS("http://www.w3.org/2000/svg", "path");
        v.setAttribute("class", "bzh3d-grid");
        v.setAttribute("d", "M" + px(t) + " " + Y0 + "V" + Y1);
        svg.appendChild(v);
    }
    for (const m of [-1, 0, 1]) {
        const h = document.createElementNS("http://www.w3.org/2000/svg", "path");
        h.setAttribute("class", m === 0 ? "bzh3d-mid" : "bzh3d-grid");
        h.setAttribute("d", "M" + X0 + " " + py(m) + "H" + X1);
        svg.appendChild(h);
    }
    svg.appendChild(line);
    svg.appendChild(dots);
    for (const [t, label, anchor] of [[0, "0%", "start"], [0.5, "50%", "middle"], [1, "100%", "end"]]) {
        const tx = document.createElementNS("http://www.w3.org/2000/svg", "text");
        tx.setAttribute("class", "bzh3d-tick");
        tx.setAttribute("x", px(t));
        tx.setAttribute("y", 71);
        tx.setAttribute("text-anchor", anchor);
        tx.textContent = label;
        svg.appendChild(tx);
    }
    for (const [m, label] of [[1, "+1"], [0, "0"], [-1, "−1"]]) {
        const ty = document.createElementNS("http://www.w3.org/2000/svg", "text");
        ty.setAttribute("class", "bzh3d-tick");
        ty.setAttribute("x", X0 + 2);
        ty.setAttribute("y", py(m) + 3);
        ty.textContent = label;
        svg.appendChild(ty);
    }

    for (const name of Object.keys(CURVE_PRESETS)) {
        const b = document.createElement("button");
        b.className = "bzh3d-preset";
        b.textContent = name;
        b.title = "应用预设：" + name;
        b.onclick = (e) => {
            e.stopPropagation();
            points = CURVE_PRESETS[name].map((p) => p.slice());
            current = name;
            setPoints(points, false);
        };
        presets.appendChild(b);
    }

    function svgPos(e) {
        const p = svg.createSVGPoint();
        p.x = e.clientX; p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return [clamp((q.x - X0) / (X1 - X0), 0, 1),
            clamp((YMID - q.y) / (YMID - Y0), -1, 1)];
    }

    function draw() {
        line.setAttribute("d", pathOf(points));
        dots.innerHTML = "";
        points.forEach((p, i) => {
            const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            c.setAttribute("class", "bzh3d-anchor");
            c.setAttribute("cx", px(p[0]));
            c.setAttribute("cy", py(p[1]));
            c.setAttribute("r", 3.5);
            c.dataset.i = String(i);
            dots.appendChild(c);
        });
        for (const b of presets.children) {
            b.classList.toggle("bzh3d-on", b.textContent === current);
        }
    }

    function commit() {
        onChange(points.map((p) => [Number(p[0].toFixed(3)), Number(p[1].toFixed(3))]), current);
    }

    svg.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        const target = e.target;
        if (target.dataset && target.dataset.i !== undefined) {
            drag = Number(target.dataset.i);
        } else {
            const pos = svgPos(e);
            points.push(pos);
            points.sort((a, b) => a[0] - b[0]);
            drag = points.findIndex((p) => p === pos);
            current = "自定义";
            draw(); commit();
        }
    });
    const onMove = (e) => {
        if (drag < 0 || !wrap.isConnected) return;
        const pos = svgPos(e);
        const i = drag;
        points[i][1] = pos[1];
        if (i > 0 && i < points.length - 1) {
            points[i][0] = clamp(pos[0], points[i - 1][0] + 0.02, points[i + 1][0] - 0.02);
        }
        current = "自定义";
        draw();
    };
    const onUp = () => {
        if (drag < 0) return;
        drag = -1;
        commit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    svg.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const i = Number(e.target.dataset?.i);
        if (Number.isInteger(i) && i > 0 && i < points.length - 1 && points.length > 2) {
            points.splice(i, 1);
            current = "自定义";
            draw(); commit();
        }
    });
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());

    function setPoints(next, keepPreset) {
        points = next.map((p) => [Number(p[0]), Number(p[1])]);
        if (!keepPreset) { /* 预设由调用方指定 current */ }
        draw();
        commit();
    }

    draw();
    return { el: wrap, setPoints, getPoints: () => points.map((p) => p.slice()) };
}
