import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 判断节点当前是否在画布可视区内（同步只覆盖视口内的节点，视口外不解码）。
// 换算必须用官方 DragAndScale 的口径 convertOffsetToCanvas：
// screen = (graph + offset) * scale —— 少乘一次 scale 就会把节点算到屏幕外，
// 画布一缩放同步就等于全空。
function isNodeVisible(node) {
    const canvas = app.canvas;
    if (!canvas?.ds) return true;
    const { scale, offset } = canvas.ds;
    const x = (node.pos[0] + offset[0]) * scale;
    const y = (node.pos[1] + offset[1]) * scale;
    const w = node.size[0] * scale;
    const h = node.size[1] * scale;
    const cw = canvas.canvas?.clientWidth || window.innerWidth;
    const ch = canvas.canvas?.clientHeight || window.innerHeight;
    return x + w > 0 && y + h > 0 && x < cw && y < ch;
}

// ═══════════════════════════════════════════════════════════
// 视频同步控制器
// 只管当前画布视口内的「视频合并」节点预览：视口外一律不参与、不解码。
//   · 帧号是唯一真相：拖动 / 逐帧把帧号换算成时间 seek，精确到帧
//   · 播放交给 video 原生连续解码，起播前统一对齐一次，帧号轴按片段帧率换算
//   · 统一控制条（帧滑块 / 播放暂停 / 逐帧 ±1 / 退出）
//   · 帧号上限取各片段最短者，更长的停在它自己的末帧
//   · 持久开关（菜单项勾选状态持续生效）
//
// 刻意不做「播放时钟追赶」：解码器时钟在浏览器内部，从外面只能求它快一点，
// 残差消不掉，改 rate 还会触发解码速率切换。同步靠对齐 + 寻址，不靠追赶。
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// 解码缓冲空闲释放（内存）—— 模块顶层：同步控制器与节点预览都要用
// video 一旦播放过就会把整片留在内存里：实测 3 个合并节点共约 1GB+，
// 删掉节点内存立刻回落（用户已实测验证）。策略：
//   显首帧 → 截成 <img> 海报 → 丢掉 video 解码缓冲；
//   空闲 20 秒再丢一次（播放中/刚操作过不丢）；
//   点播放时原样装回（src 与 currentTime 都还原，海报顶着不黑屏）。
// preload="metadata" 挡不住「播放过」的 buffer，只有 removeAttribute+load
// 才能真正把它交还浏览器。
// ═══════════════════════════════════════════════════════════
const BZ_IDLE_RELEASE_MS = 20000;
function bzSetVideoSrc(v, src) {
    // 统一入口：任何直接赋 src 的地方都必须走这里，否则会把已释放状态
    // 的旧 src 留在 _bzReleased 里，点播放时盖回旧片
    v._bzReleased = null;
    clearTimeout(v._bzIdleTimer);
    v._bzIdleTimer = null;
    v.src = src;
}
function bzReleaseVideoBuffer(v) {
    if (!v || !v.getAttribute("src")) return;
    // 执行时再判一次：定时器是在「非同步」时刻排下的，到点时可能已经进了同步。
    // 只在排程处判会被跨过，症状是「开着同步，20 秒后画面突然冻住不动」。
    if (window.VideoSyncController?.enabled) return;
    // 没有海报顶着就不许释放：释放会把 video 藏起来，没海报就是纯黑屏。
    // 同步退出后会走到这里（此前 video 是显示态），必须留这道门。
    if (!v.parentElement?.querySelector("img.bz-still")) return;
    v._bzReleased = { src: v.getAttribute("src"), t: v.currentTime || 0 };
    clearTimeout(v._bzIdleTimer);
    v._bzIdleTimer = null;
    v.pause();                      // onpause 里看到 _bzReleased 已置位，不会重启定时器
    bzCaptureCurrentFrame(v, v.parentElement.querySelector("img.bz-still"));
    bzShowFrame(v, false);          // 当前帧顶上来，画面不黑也不跳首帧
    v.removeAttribute("src");
    v.load();                       // 真正把已缓冲的媒体数据交还浏览器
}
function bzScheduleRelease(v) {
    if (!v || v._bzReleased) return;
    // 同步预览期间必须保住解码缓冲：控制器全靠 video 的 src 做帧号寻址，
    // 一旦释放 readyState 归 0，seek / play / 帧数轴三处全部静默失效
    // —— 上一版就是被这条空闲释放打死的。退出同步后会重新排程。
    // 用 window 上的引用而不是直接读常量：本函数定义在控制器之前，读到 TDZ 会抛。
    if (window.VideoSyncController?.enabled) return;
    clearTimeout(v._bzIdleTimer);
    v._bzIdleTimer = setTimeout(() => bzReleaseVideoBuffer(v), BZ_IDLE_RELEASE_MS);
}
function bzCancelRelease(v) {
    if (!v) return;
    clearTimeout(v._bzIdleTimer);
    v._bzIdleTimer = null;
}
// 有人要播放：必要时先把缓冲装回（有 0.3~2s 重载延迟）
function bzEnsureVideoSrc(v, onReady) {
    const r = v?._bzReleased;
    if (!r) { onReady?.(); return; }
    v._bzReleased = null;
    clearTimeout(v._bzIdleTimer);   // 上一轮排的释放到点会把刚装回的又抽走
    v._bzIdleTimer = null;
    v.src = r.src;
    const seek = () => { try { v.currentTime = r.t; } catch (_) {} bzShowFrame(v, true); onReady?.(); };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
}
// 画面只有两个来源：播放中的原片、停下来的那一帧。暂停瞬间直接从原片截，
// 不经过后端也不降分辨率；拖时间轴才由 bzFetchFrame 按帧号去后端取。
function bzCaptureCurrentFrame(v, img) {
    if (!img || img._bzIsStillMode || !v.videoWidth || !v.videoHeight) return false;
    try {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        if (img._bzObjURL) { URL.revokeObjectURL(img._bzObjURL); img._bzObjURL = null; }
        img.src = c.toDataURL("image/jpeg", 0.92);
        return true;
    } catch (_) { return false; }
}

// 片源卸掉后拖时间轴不依赖 <video>，只向后端要这一帧：
// fast 跟手、松手换 full 原尺寸；token 挡住「拖过头旧帧贴回来」。
function bzFrameInfo(node) {
    const d = node?.properties?.["painter_output_cache"];
    return d?.src_path ? { path: d.src_path, frames: Number(d.frame_count) || 0,
                          fps: Number(d.fps) || 24 } : null;
}
function bzFetchFrame(node, v, frame, mode) {
    const info = bzFrameInfo(node);
    if (!info) return;
    const img = v.parentElement?.querySelector("img.bz-still");
    if (!img || img._bzIsStillMode) return;
    const token = (v._bzFrameToken = (v._bzFrameToken || 0) + 1);
    const url = "/banzhang/video_frame?path=" + encodeURIComponent(info.path)
        + "&frame=" + Math.max(0, Math.round(frame)) + "&mode=" + mode;
    fetch(url).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then(blob => {
            if (token !== v._bzFrameToken) return;
            const obj = URL.createObjectURL(blob);
            if (img._bzObjURL) URL.revokeObjectURL(img._bzObjURL);
            img._bzObjURL = obj;
            img.src = obj;
            v.style.display = "none";
            img.style.display = "block";
            if (v._bzPlayBtn) v._bzPlayBtn.innerText = "▶️";
        }).catch(() => {});
}

// video / 静态帧二选一显示。图片模式的图就是正式内容，不参与切换。
function bzShowFrame(v, showVideo) {
    const box = v.parentElement;
    if (!box) return;
    const img = box.querySelector("img.bz-still");
    if (img && img._bzIsStillMode) return;
    v.style.display = showVideo ? "block" : "none";
    if (img) img.style.display = showVideo ? "none" : "block";
    // 播放按钮图标是「当前是否在播」的投影，必须跟着画面切换一起刷新。
    // 只靠 onplay/onpause 补不齐：预览恢复时是「截首帧→释放缓冲→pause()」，
    // 从未播放过就不会触发 pause 事件，图标会一直撒谎显示 ⏸️。
    const btn = v._bzPlayBtn;
    if (btn) btn.innerText = (showVideo && !v.paused) ? "⏸️" : "▶️";
}

const VideoSyncController = {
    enabled: false,
    videos: [],      // 当前视口内、参与同步的片段
    frame: 0,        // 当前帧号：唯一的真相
    playing: false,  // 播放走 video 原生解码，seek 只发生在起播/暂停/逐帧/拖动
    _pendingPlay: false, // 点了播放但缓冲在装回中：元数据齐了自动续播
    timer: null,     // 常驻低频监视（视口进出、播放末尾、控制条）
    bar: null,

    // 遍历画布上所有「视频合并」节点的预览视频（含视口外的）
    eachVideo(fn) {
        app.graph._nodes.forEach(n => {
            if (n.type !== "banzhangVideoCombine") return;
            const video = n.widgets?.find(w => w.name === "painter_preview")?.element?.querySelector("video");
            if (video) fn(video, n);
        });
    },

    // 只采集当前视口内的片段：视口外不参与、不解码，滚动进出由 watch() 实时调整
    scan() {
        const list = [];
        this.eachVideo((video, n) => {
            if (!isNodeVisible(n)) return;
            // 图片模式的节点没有片源，拉进来只会让 maxFrame 被 0 拖死；
            // 释放态虽也没有 src，但 _bzReleased 记着原片地址，属于正常参与方
            if (!video.getAttribute("src") && !video._bzReleased) return;
            const fps = n._painter_fps || 24;
            // 后端没给帧数（旧工作流 / 编码失败残留）时用时长反推，至少有得对齐
            const frames = n._painter_frames || (video.duration ? Math.round(video.duration * fps) : 0);
            list.push({ node: n, video, fps, frames });
        });
        this.videos = list;
        return list;
    },

    // 帧号轴基准：同一条工作流产出的片段帧率一致，取第一个即可。
    // 万一混了不同帧率，各片段仍按自身 fps 换算时间，只是播放速率被拉平到这条轴上。
    get fps() {
        return this.videos[0]?.fps || 24;
    },

    // 可同步的帧号上限：各片段长度不同，取最短的那个，长的就停在它自己的末帧
    get maxFrame() {
        const ns = this.videos.map(v => v.frames).filter(n => n > 0);
        return ns.length ? Math.max(0, Math.min(...ns) - 1) : 0;
    },

    // 定位 = 帧号广播：按各自 fps 换算成时间 seek。逐帧 / 拖动靠它，精确到帧。
    setFrame(k, force) {
        const max = this.maxFrame;
        this.frame = Math.max(0, Math.min(Math.round(k), max));
        this.videos.forEach(v => this._seek(v, force));
        this.updateBar();
    },

    // 视频缓冲可能已被空闲释放（不开同步时的常态）：装回片源再操作。
    // 返回 false = 本轮还用不了（元数据未到），调用方跳过，绝不许当成功。
    _ensure(v) {
        const el = v.video;
        if (el.readyState >= 1) { this.refreshFrames(v); return true; }
        // 装回进行中不重复发请求；3 秒还没到元数据（文件被删/路径失效）才允许重试
        if (el._bzEnsuring && Date.now() - el._bzEnsuring < 3000) return false;
        el._bzEnsuring = Date.now();
        bzEnsureVideoSrc(el, () => {
            el._bzEnsuring = 0;
            if (!this.enabled) return;          // 等元数据期间已退出同步
            bzShowFrame(el, true);              // 此前顶的是海报，切回 video
            this.refreshFrames(v);
            this._seek(v, true);                // 补到当前同步帧，别停在释放时的位置
            if (this._pendingPlay && this.videos.length
                && this.videos.every(x => x.video.readyState >= 1)) {
                this._pendingPlay = false;
                this.play();                     // 齐了，续上用户点的那次播放
            }
        });
        return false;
    },

    // 帧数回填：scan 时缓冲若已被释放，duration 是 NaN → frames 算成 0 →
    // maxFrame 锁在 0，滑块和逐帧全部无效。元数据到手后补一次，并写回节点复用。
    refreshFrames(v) {
        if (v.frames > 0) return;
        const n = v.node._painter_frames
            || (v.video.duration ? Math.round(v.video.duration * v.fps) : 0);
        if (n > 0) { v.frames = n; v.node._painter_frames = n; this.updateBar(); }
    },

    _seek(v, force) {
        if (!this._ensure(v)) return;
        const t = this.frame / v.fps;
        if (force || Math.abs(v.video.currentTime - t) > 0.5 / v.fps) v.video.currentTime = t;
    },

    enable() {
        // 同步是个开关不是一次性动作：集合允许为空（比如全在视口外），
        // 滚进来后 watch 会自动补上 —— 不该在这里静默失败，点了菜单没反应最坑
        this.enabled = true;
        this.playing = false;
        this._pendingPlay = false;
        this.scan();
        // 同步态 = 缓冲驻留态：节点出片后会立刻把 src 抽掉只留海报，
        // 不先装回，下面所有 seek / play 都落在 readyState 0 上（整条链静默失效）。
        this.videos.forEach(v => this._ensure(v));
        // 同步期间所有片段（含视口外）都停下自播：视口外的连解码都不该有
        this.eachVideo(v => { v.pause(); v.playbackRate = v._bzRate || 1; });
        this.showBar();
        this.timer = setInterval(() => this.watch(), 200);
    },

    disable() {
        this.enabled = false;       // 先落标志：下面的排程释放要靠它放行
        this.playing = false;
        this._pendingPlay = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        // 退出同步**不恢复自播**：各片段停在当前帧，要再看由用户点画面/播放钮
        // （bzEnsureVideoSrc 会原样装回）。旧实现在这里 play() 所有视频（含视口外），
        // muted 视频被浏览器直接放行自动播放 → 3 个节点 = 3 路 loop 无限解码，
        // 实测空闲 CPU 148%、风扇狂转。根因就这一行，不是补丁。
        this.eachVideo(v => {
            v.pause();
            v.playbackRate = v._bzRate || 1;
            // 画面切回海报，并按常规空闲策略排程释放：同步期间没交还的缓冲在这里还
            if (v.getAttribute("src")) {
                if (v.parentElement?.querySelector("img.bz-still")) bzShowFrame(v, false);
                bzScheduleRelease(v);
            }
        });
        this.videos = [];
        this.hideBar();
    },

    // 播放交给 video 原生连续解码 —— 「一卡一卡」的根因就是逐帧 seek：
    // seek 到非关键帧必须回退到前一个 IDR 重新解码，多路同时做必然跟不上帧率。
    // 帧号轴统一按片段帧率，其余片段用固定 playbackRate 换算；rate 只在起播时
    // 设一次、中途不动，所以不会触发解码速率切换。
    async play() {
        if (this.playing || !this.videos.length) return;
        // 释放态（readyState 0）下 targets 会是空数组 → 点了完全没反应。
        // 先统一装回，元数据齐了由 _ensure 回调续上这次播放意图。
        if (this.videos.some(v => v.video.readyState < 1)) {
            this._pendingPlay = true;
            this.videos.forEach(v => this._ensure(v));
            return;
        }
        this.playing = true;
        const targets = this.videos.filter(v => v.video.readyState >= 1);
        if (!targets.length) { this.playing = false; return; }
        // 停在末帧时按播放，从 0 重来：否则一起来就被末尾判定拉回，闪一下
        if (this.frame >= this.maxFrame) this.setFrame(0, false);
        const frame = this.frame;
        await Promise.all(targets.map(v => this._seekAndWait(v, frame)));
        if (!this.playing) return;        // 等待期间被暂停或关闭
        targets.forEach(v => {
            // 缓冲可能已被空闲释放：装回再起播（未释放时这是同步直达）
            bzEnsureVideoSrc(v.video, () => {
                v.video.playbackRate = this._rate(v);
                v.video.play().catch(() => {});
            });
        });
        this.updateBar();
    },

    // 各片段相对帧号轴的播放速率：轴 24fps 配 30fps 片段即 0.8，再乘用户倍速。
    // 用户倍速必须在这里并入：本控制器持续改写 playbackRate，单独在外面设会被冲掉。
    _rate(v) {
        return (this.fps / (v.fps || 24)) * (v.video._bzRate || 1);
    },

    // 用户改倍速后重算所有片段的速率（只在被调时写，watch 里不碰）
    refreshRate() {
        this.videos.forEach(v => { v.video.playbackRate = this._rate(v); });
    },

    // 等 seek 落地再起播，起播参差就只剩毫秒级；超时兜底避免个别片段拖住整体
    _seekAndWait(v, frame) {
        const t = frame / v.fps;
        if (Math.abs(v.video.currentTime - t) <= 0.5 / v.fps) return Promise.resolve();
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                v.video.removeEventListener("seeked", finish);
                resolve();
            };
            v.video.addEventListener("seeked", finish);
            setTimeout(finish, 400);
            v.video.currentTime = t;
        });
    },

    // 停下原生播放但不回拉位置：拖动 / 逐帧要立刻定位，回拉等于白跑一次 seek
    _stopPlayback() {
        if (!this.playing) return;
        this.playing = false;
        this.videos.forEach(v => { v.video.pause(); v.video.playbackRate = v.video._bzRate || 1; });
    },

    // 暂停 = 停下播放并把公共进度拉回帧号，让所有人重新严格对齐。
    // playbackRate 已按帧率换算，各片段的 currentTime 就是公共进度，任取一个即可。
    pause() {
        if (!this.playing) return;
        this._stopPlayback();
        const v = this.videos[0];
        if (v) this.setFrame(Math.round(v.video.currentTime * this.fps), true);
    },

    togglePlay() {
        if (this.playing) this.pause();
        else this.play();
    },

    // 逐帧：暂停后单步，天然精确到帧
    step(delta) {
        this._stopPlayback();
        this.setFrame(this.frame + delta, true);
    },

    // 拖动帧滑块：直接落到目标帧
    seekFrame(k) {
        this._stopPlayback();
        this.setFrame(k, true);
    },

    // 常驻低频监视（200ms）：视口进出、播放末尾回绕、控制条刷新。
    // 播放期间这里一个字都不往 currentTime / playbackRate 上写，不干扰解码。
    watch() {
        if (!this.enabled) return;
        const prev = this.videos;
        this.scan();
        const nowNodes = new Set(this.videos.map(v => v.node));

        // 滚出视口的：立刻停解码，不再参与同步
        prev.forEach(v => { if (!nowNodes.has(v.node)) v.video.pause(); });

        // 释放态的视频捞不起来（_join 要求 readyState >= 2，会一直早退），
        // 所以先补装回；非播放态同样要装，否则拖滑块命中 readyState 0 依然没反应
        this.videos.forEach(v => this._ensure(v));

        // 播放态不变量：视口内每个片段都该在播。刚滚进视口的、元数据迟到还没被
        // 起播的，都由 _join 补上；已就位在播的直接返回。
        if (this.playing) this.videos.forEach(v => this._join(v));

        // 播到最短片段的末尾就整体回绕，否则长的还在走、短的已经自己循环了
        const pacer = this.videos[0];
        if (this.playing && pacer) {
            const end = (this.maxFrame + 1) / this.fps;
            if (pacer.video.currentTime >= end) {
                this._stopPlayback();
                this.videos.forEach(v => v.video.pause());
                this.setFrame(0, true);
                return;
            }
        }
        this.updateBar();
    },

    // 让一个片段归位到当前帧并起播；已就位在播的直接返回。
    // 用元素上的标记防重入：seek 最长等 400ms，而 watch 每 200ms 一轮。
    _join(v) {
        const el = v.video;
        if (el._bz_joining || el.seeking || el.readyState < 2 || !el.paused) return;
            el._bz_joining = true;
            this._seekAndWait(v, this.frame).then(() => {
                el._bz_joining = false;
                if (!this.enabled || !this.playing || !el.paused) return;
                if (!isNodeVisible(v.node)) return;   // 等待期间已滚出视口
                bzEnsureVideoSrc(el, () => {           // 缓冲被释放过就先装回
                    el.playbackRate = this._rate(v);
                    el.play().catch(() => {});
                });
            });
    },

    showBar() {
        if (this.bar) { this.bar.style.display = "flex"; this.updateBar(); return; }

        const bar = document.createElement("div");
        bar.style.cssText = `
            position:fixed; left:50%; top:52px; transform:translateX(-50%);
            z-index:99999; display:flex; align-items:center; gap:10px;
            padding:6px 12px; border-radius:8px;
            background:rgba(18,18,18,0.92); border:1px solid #333;
            box-shadow:0 2px 12px rgba(0,0,0,0.5);
            font-family:-apple-system,'Microsoft YaHei','Segoe UI',sans-serif;
            font-size:12px; color:#bbb;
        `;
        bar.innerHTML = `
            <style>
                .bz-sb-title { color:#999; font-size:11px; white-space:nowrap; }
                .bz-sb-btn { background:none; border:none; cursor:pointer; font-size:15px; color:#999; padding:0 2px; line-height:1; }
                .bz-sb-btn:hover { color:#ddd; }
                .bz-sb-seek { width:160px; height:4px; cursor:pointer; accent-color:#888; margin:0; }
                .bz-sb-time { min-width:78px; text-align:center; color:#888; font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
            </style>
            <span class="bz-sb-title">🎬 同步</span>
            <button class="bz-sb-btn" data-act="prev" title="上一帧">◀</button>
            <button class="bz-sb-btn" data-act="play" title="播放/暂停">▶️</button>
            <button class="bz-sb-btn" data-act="next" title="下一帧">▶</button>
            <input class="bz-sb-seek" data-act="seek" type="range" min="0" max="0" value="0">
            <span class="bz-sb-time" data-act="time">0 / 0</span>
            <button class="bz-sb-btn" data-act="close" title="退出同步">✕</button>
        `;
        document.body.appendChild(bar);
        this.bar = bar;

        bar.querySelector('[data-act="play"]').addEventListener("click", () => this.togglePlay());
        bar.querySelector('[data-act="prev"]').addEventListener("click", () => this.step(-1));
        bar.querySelector('[data-act="next"]').addEventListener("click", () => this.step(1));
        bar.querySelector('[data-act="close"]').addEventListener("click", () => this.disable());
        bar.querySelector('[data-act="seek"]').addEventListener("input", (e) => this.seekFrame(+e.target.value));
        this.updateBar();
    },

    hideBar() {
        if (this.bar) this.bar.style.display = "none";
    },

    updateBar() {
        if (!this.bar) return;
        const max = this.maxFrame;
        // 播放时进度由解码推进，暂停/逐帧时由 this.frame 决定；
        // playbackRate 已按帧率换算，任取一个片段的 currentTime 就是公共进度
        const pacer = this.videos[0];
        const frame = this.playing && pacer
            ? Math.max(0, Math.min(Math.round(pacer.video.currentTime * this.fps), max))
            : this.frame;
        const titleEl = this.bar.querySelector(".bz-sb-title");
        const playBtn = this.bar.querySelector('[data-act="play"]');
        const seek = this.bar.querySelector('[data-act="seek"]');
        const timeEl = this.bar.querySelector('[data-act="time"]');
        titleEl.textContent = `🎬 同步 · ${this.videos.length}个`;
        playBtn.textContent = this.playing ? "⏸️" : "▶️";
        if (seek.max !== String(max)) seek.max = String(max);
        if (seek.value !== String(frame)) seek.value = String(frame);
        timeEl.textContent = `${frame} / ${max}`;
    },
};

// 暴露到全局，方便控制台手动调进度（如 VideoSyncController.setFrame(120, true)）
window.VideoSyncController = VideoSyncController;

// 版本标记必须打在文件最外层：ComfyUI 批量加载扩展时，只要有别的扩展 404/失败，
// 整批 setup() 都会被跳过，写在 setup 里的日志永远不会出现，等于没有验证手段
console.log("[班长视频合并] 前端 v1.21 已加载（画幅贴合：预览实宽推高＋补回 DOM 层 22px 边距；DOM 挂载后自动补一次重排；拖动实时跟随 + 400ms 自愈巡逻）");

// 调色参数表：控件名 / 默认值 / 滑条范围 / 显示格式，一处定义，面板、写入、恢复共用
const BZ_TUNE_SPEC = [
    { g: "饱和度", c: "#8ad4a8", rows: [
        { k: "sat", w: "🎨 饱和度", label: "饱和度", min: 0, max: 200, def: 100, scale: 100, unit: "%" },
    ]},
    { g: "泛光 Bloom", c: "#f0c674", rows: [
        { k: "bloom",    w: "✨ 泛光强度", label: "强度", min: 0, max: 100, def: 0,  scale: 100, unit: "%" },
        { k: "bloomThr", w: "✨ 泛光起点", label: "起点 · 多亮才发光", min: 0, max: 95, def: 75, scale: 100, unit: "%" },
        { k: "bloomRad", w: "✨ 泛光范围", label: "范围 · 扩散多远", min: 1, max: 10, step: 0.5, def: 4, scale: 1, unit: "" },
    ]},
    { g: "柔雾 Mist", c: "#a8c8f0", rows: [
        { k: "soft",    w: "🌫️ 柔雾强度", label: "强度 · 柔焦量", min: 0, max: 100, def: 0,  scale: 100, unit: "%" },
        { k: "softRad", w: "🌫️ 柔焦范围", label: "柔焦范围", min: 1, max: 10, step: 0.5, def: 4, scale: 1, unit: "" },
        { k: "haze",    w: "🌫️ 灰雾浓度", label: "灰雾 · 抬黑位", min: 0, max: 100, def: 30, scale: 100, unit: "%" },
    ]},
    { g: "暖晕 Halation", c: "#f0a86a", rows: [
        { k: "warm",    w: "🔥 暖晕强度", label: "强度 · 红橙溢出", min: 0, max: 100, def: 0,  scale: 100, unit: "%" },
        { k: "warmThr", w: "🔥 暖晕起点", label: "起点 · 多亮才出暖晕", min: 0, max: 95, def: 70, scale: 100, unit: "%" },
        { k: "warmRad", w: "🔥 暖晕范围", label: "范围 · 扩散多远", min: 1, max: 10, step: 0.5, def: 5, scale: 1, unit: "" },
    ]},
];

const BZ_TUNE_FLAT = BZ_TUNE_SPEC.flatMap(g => g.rows.map(r => ({ ...r, color: g.c })));

// 上一版存的老属性名 → 新参数名，仅用于迁移用户已经调好的值
const BZ_TUNE_LEGACY = {
    bz_preview_sat: "sat", bz_preview_bloom: "bloom",
    bz_preview_bloom_thr: "bloomThr", bz_preview_bloom_rad: "bloomRad",
    bz_preview_soft: "soft", bz_preview_warm: "warm",
};

function bzTuneDefaults() {
    const t = {};
    BZ_TUNE_FLAT.forEach(r => { t[r.k] = r.def / r.scale; });
    return t;
}

/** 面板样式只注入一次（玻璃质感 + 细滑条，配色随主题走深色） */
function bzInjectTuneStyle() {
    if (document.getElementById("bz-tune-style")) return;
    const s = document.createElement("style");
    s.id = "bz-tune-style";
    s.textContent = `
.bz-tune-panel{position:fixed;z-index:10000;width:238px;box-sizing:border-box;border-radius:12px;overflow:hidden;
background:linear-gradient(180deg,rgba(32,32,37,.97),rgba(21,21,25,.97));border:1px solid rgba(255,255,255,.09);
box-shadow:0 14px 34px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.45);backdrop-filter:blur(14px);
font-family:-apple-system,'Microsoft YaHei','Segoe UI',sans-serif;color:#e8e8ea;user-select:none;}
.bz-tune-head{display:flex;align-items:center;gap:7px;padding:9px 11px 8px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.035);}
.bz-tune-head b{flex:1;font-size:12px;font-weight:600;letter-spacing:.4px;}
.bz-tune-x{background:none;border:none;color:#999;cursor:pointer;font-size:13px;line-height:1;padding:2px 3px;border-radius:4px;}
.bz-tune-x:hover{color:#fff;background:rgba(255,255,255,.1);}
.bz-tune-body{padding:2px 11px 4px;max-height:min(72vh,620px);overflow-y:auto;}
.bz-tune-body::-webkit-scrollbar{width:6px}
.bz-tune-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
.bz-grp{margin-top:9px}
.bz-grp-t{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#d2d2d8;margin:0 0 6px}
.bz-grp-t i{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}
.bz-grp-t u{flex:1;height:1px;background:rgba(255,255,255,.09);text-decoration:none}
.bz-row{display:flex;align-items:center;justify-content:space-between;margin:0 0 2px}
.bz-row span{font-size:10.5px;color:#96969e}
.bz-row b{font-size:10.5px;font-weight:600;font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.bz-tune-range{-webkit-appearance:none;appearance:none;width:100%;height:13px;margin:0 0 8px;background:transparent;cursor:pointer;display:block}
.bz-tune-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;
background:linear-gradient(to right,var(--c) 0 var(--p),rgba(255,255,255,.13) var(--p) 100%)}
.bz-tune-range::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-4px;border-radius:50%;
background:#f4f4f6;border:2px solid var(--c);box-shadow:0 1px 3px rgba(0,0,0,.5)}
.bz-tune-range::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,.13)}
.bz-tune-range::-moz-range-progress{height:3px;border-radius:2px;background:var(--c)}
.bz-tune-range::-moz-range-thumb{width:9px;height:9px;border-radius:50%;background:#f4f4f6;border:2px solid var(--c)}
.bz-tune-foot{display:flex;gap:6px;padding:8px 11px;border-top:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.02)}
.bz-btn{flex:1;padding:5px 0;border-radius:8px;font-size:11px;cursor:pointer;text-align:center;
border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#d8d8dc;
font-family:inherit;transition:background .12s}
.bz-btn:hover{background:rgba(255,255,255,.13)}
.bz-btn.main{flex:1.4;background:#3a6ea5;border-color:#4a80bb;color:#fff;font-weight:600}
.bz-btn.main:hover{background:#4a80bb}
.bz-tune-msg{padding:0 11px 9px;font-size:10.5px;line-height:1.4;color:#8a8a92;min-height:13px}
`;
    document.head.appendChild(s);
}

/**
 * 构建/更新「泛光 → 暖晕 → 柔雾」SVG 滤镜（每节点复用同一个 <filter id="bz-bloom-<id>">）
 * CSS filter 做不出「只让亮部发光」（blur 会糊整张图），必须走 SVG：
 *   亮度矩阵取亮度 → 阈值截断 → 抠出原色高光 → 高斯模糊 →（暖晕分支另走一条阈值再染红橙）
 *   → 分别叠加 → 柔焦混底 + 降对比抬黑位
 * 与后端 _apply_tuning 的泛光/暖晕/柔雾分支同构，同样只用单次高斯。
 * t: 调色参数对象（含 width）
 */
function bzBuildBloomFilter(nodeId, t) {
    let defs = document.getElementById("bz-bloom-defs");
    if (!defs) {
        defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        defs.id = "bz-bloom-defs";
        defs.setAttribute("width", "0");
        defs.setAttribute("height", "0");
        defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
        document.body.appendChild(defs);
    }
    const id = "bz-bloom-" + nodeId;
    let f = defs.querySelector('filter[id="' + id + '"]');
    if (!f) {
        f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
        f.setAttribute("id", id);
        defs.appendChild(f);
    }

    const bloom = +t.bloom || 0;
    const warm = +t.warm || 0;
    const soft = +t.soft || 0;
    const W = t.width || 400;
    // 阈值线性截断：out = slope*in + intercept（低于起点的被压成 0）
    const cut = (thr) => {
        const span = Math.max(0.05, 1 - thr);
        return [(1 / span).toFixed(4), (-thr / span).toFixed(4)];
    };
    const [bs, bi] = cut(t.bloomThr == null ? 0.75 : +t.bloomThr);
    const [ws, wi] = cut(t.warmThr == null ? 0.70 : +t.warmThr);
    // stdDeviation 按预览宽度换算，保证与后端「相对画面比例」一致
    const sdB = ((+t.bloomRad || 4) * 0.005 * W).toFixed(2);
    const sdW = ((+t.warmRad || 5) * 0.005 * W).toFixed(2);
    // 柔焦与后端同一套系数：混入比例 / 半径（按宽度取比例）/ 灰雾降对比抬黑位
    const mix = soft * 0.5;
    const sdS = ((+t.softRad || 4) * 0.0022 * W).toFixed(2);
    const haze = +t.haze || 0;
    const cSlope = (1 - haze * 0.18).toFixed(4);
    const cIntercept = (haze * 0.055 - (1 - haze * 0.18) * 0.5 + 0.5).toFixed(4);

    const parts = [];
    parts.push(`<feColorMatrix in="SourceGraphic" type="matrix" result="lum" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0"/>`);
    // ── 泛光分支 ──
    parts.push(`<feComponentTransfer in="lum" result="maskB">
        <feFuncR type="linear" slope="${bs}" intercept="${bi}"/>
        <feFuncG type="linear" slope="${bs}" intercept="${bi}"/>
        <feFuncB type="linear" slope="${bs}" intercept="${bi}"/>
    </feComponentTransfer>`);
    parts.push(`<feComposite in="SourceGraphic" in2="maskB" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="brightB"/>`);
    parts.push(`<feGaussianBlur in="brightB" stdDeviation="${sdB}" result="glowB"/>`);
    parts.push(`<feComposite in="SourceGraphic" in2="glowB" operator="arithmetic" k1="0" k2="1" k3="${bloom}" k4="0" result="mB"/>`);
    // ── 暖晕分支：独立阈值与半径，只把溢出光染成红橙（红几乎全留、蓝衰减最狠）──
    parts.push(`<feComponentTransfer in="lum" result="maskW">
        <feFuncR type="linear" slope="${ws}" intercept="${wi}"/>
        <feFuncG type="linear" slope="${ws}" intercept="${wi}"/>
        <feFuncB type="linear" slope="${ws}" intercept="${wi}"/>
    </feComponentTransfer>`);
    parts.push(`<feComposite in="SourceGraphic" in2="maskW" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="brightW"/>`);
    parts.push(`<feGaussianBlur in="brightW" stdDeviation="${sdW}" result="glowW0"/>`);
    parts.push(`<feColorMatrix in="glowW0" type="matrix" result="glowW" values="1.35 0 0 0 0  0 0.60 0 0 0  0 0 0.28 0 0  0 0 0 1 0"/>`);
    parts.push(`<feComposite in="mB" in2="glowW" operator="arithmetic" k1="0" k2="1" k3="${warm}" k4="0" result="mW"/>`);
    // ── 柔雾：混底柔焦 + 降对比抬黑位（放最后，连光晕一起柔化才像镜头整体柔光）──
    // 灰雾单独改动（柔雾强度增量为 0）也要走这段对比度调整，否则灰雾滑条「没反应」
    if (soft > 0.005 || haze > 0.005) {
        parts.push(`<feGaussianBlur in="mW" stdDeviation="${sdS}" result="softBlur"/>`);
        parts.push(`<feComposite in="mW" in2="softBlur" operator="arithmetic" k1="0" k2="${(1 - mix).toFixed(4)}" k3="${mix.toFixed(4)}" k4="0" result="softMix"/>`);
        parts.push(`<feComponentTransfer in="softMix">
            <feFuncR type="linear" slope="${cSlope}" intercept="${cIntercept}"/>
            <feFuncG type="linear" slope="${cSlope}" intercept="${cIntercept}"/>
            <feFuncB type="linear" slope="${cSlope}" intercept="${cIntercept}"/>
        </feComponentTransfer>`);
    }

    f.setAttribute("x", "-15%");
    f.setAttribute("y", "-15%");
    f.setAttribute("width", "130%");
    f.setAttribute("height", "130%");
    f.setAttribute("color-interpolation-filters", "sRGB");
    f.innerHTML = parts.join("\n");
}

/** 按当前参数拼出 CSS filter 串（饱和度用 CSS，泛光/暖晕/柔雾走 SVG 滤镜）
 *  注意：传入的应是「改动量」（相对基线的增量），见 refreshFilter 的基线增量模型 */
function bzFilterCss(nodeId, t) {
    // 不能写 (+t.sat || 1)：sat=0 会被 || 短路成 1，饱和度拉到 0 就「没反应」
    const s = +t.sat;
    let f = (Number.isFinite(s) && Math.abs(s - 1) >= 0.005) ? `saturate(${s})` : "";
    if ((+t.bloom || 0) > 0.005 || (+t.warm || 0) > 0.005 || (+t.soft || 0) > 0.005 || (+t.haze || 0) > 0.005) {
        bzBuildBloomFilter(nodeId, t);
        f = (f + ` url(#bz-bloom-${nodeId})`).trim();
    }
    return f;
}

/**
 * 👨‍🏫班长: 视频合并前端增强插件 (V5.0 结构化信息面板)
 * 
 * 信息面板结构:
 * ┌─ 标题栏（折叠按钮 | 📋 视频详情 | 复制全部 ─┐
 * ├─ 结构化字段行（文件/尺寸/帧数/时长/帧率/体积/编码）─┤
 * └─ 底部文件路径行（📁路径 | 📂打开目录 ─┘
 */

// 当前正在进行的那一次「应用并导出」。后端按批广播进度，按钮每 200ms 读一次
// 这里显示百分比；导出结束（成功或失败）立刻置空，避免下一段视频读到旧进度。
// 用 src 匹配：画布上可以有多个视频合并节点同时存在，广播是全局的。
let _bakeWatch = null;

app.registerExtension({
    name: "banzhang.VideoCombine",
    async setup() {
        // 节点开始执行时清位：本次运行尚未产出视频，防止失败/空跑的耗时覆盖上次真实值
        api.addEventListener("executing", ({detail}) => {
            // 兼容新版 ComfyUI: executing payload 为 {node, display_node, prompt_id} 字典
            const nodeId = (detail && typeof detail === "object") ? detail.node : detail;
            if (!nodeId) return;
            const node = app.graph.getNodeById(nodeId);
            if (!node || node.type !== "banzhangVideoCombine") return;
            node._bz_run_has_output = false;
        });

        // 调色导出进度：后端每批广播一次已处理帧数，这里只更新缓存值，
        // 显示由「应用并导出」按钮的定时器统一读，避免事件回调直接改 DOM
        api.addEventListener("banzhang.bake.progress", ({ detail }) => {
            if (!_bakeWatch || !detail || detail.src !== _bakeWatch.src) return;
            _bakeWatch.done = detail.done;
            _bakeWatch.total = detail.total;
        });

        // 监听累计执行时间事件：只更新缓存值，渲染统一由 updateInfoPanel 完成
        api.addEventListener("Banzhang-DevUtils.ExecutionTime.executed", ({detail}) => {
            if (!detail.formatted_cumulative_time) return;
            const node = app.graph.getNodeById(detail.node);
            if (!node || node.type !== "banzhangVideoCombine") return;

            // 本次运行未产出视频（如输入断开导致报错）时不覆盖上次累计耗时
            if (node._bz_run_has_output !== true) return;

            node.bz_et_formatted_cumulative_time = detail.formatted_cumulative_time;

            // 累计耗时来自运行时事件，不随工作流序列化；这里同步缓存到 properties，
            // 以便刷新/重启后 onConfigure 恢复常显
            if (node.properties) node.properties["bz_et_cumulative_time"] = detail.formatted_cumulative_time;

            // 已渲染过详情面板则整体重渲染（保证高度与累计行一致）
            if (node._painter_last_detail && node._bzUpdateInfoPanel) {
                node._bzUpdateInfoPanel(node._painter_last_detail);
            }
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "banzhangVideoCombine") return;

        const CONTROLS_HEIGHT = 44;
        // 固定画幅（方案 C）：画面高度恒等于「可用宽度 ÷ 画幅比」，与素材真实比例解耦。
        // 素材比例要等 metadata / 图片解码才拿得到，在那之前只能先用占位高度；而节点
        // 宽度恰恰也在这段时间里变（刷新恢复、拖拽），占位高度跟最终宽度对不上就是
        // 黑边的来源。画幅固定后高度只跟宽度走，任何时候算都是对的。
        const FRAME_AR = 16 / 9;
        const MAX_PREVIEW_H = 480;      // 画面高度上限：超宽节点不至于把节点撑到近千像素
        const DOM_W_INSET = 30;         // 节点宽 → 容器宽的官方内缩（实测 270→240 / 668→638，恒差 30）
        // 官方给 DOM 控件的实际高度 = computeSize()[1] + 4（widget 之间的固定间距 ——
        // 与「隐藏 widget 返回 [0,-4] 把自己抵消成 0」用的是同一个 4，实测返回值 330 →
        // computedHeight 334）。不减掉它，多出的 4px 会被画面的 flex 吃掉 → 画面比画幅
        // 高 4px → 上下各 2px 黑边。
        const WIDGET_GAP = 4;
        // 正在从工作流恢复（onConfigure）：此间一切自动重排都不许动节点尺寸
        let _bzConfiguring = false;
        const INFO_HEADER_H = 30;
        const INFO_ROW_H = 22;
        const INFO_PATH_ROW_H = 30;
        const INFO_PADDING = 16;   // 上下 padding 合计

        // 面板高度按字段数静态推算。
        // 不能用 scrollHeight 实测：computeSize 会在 onConfigure / 刷新等
        // DOM 尚未挂载的时机被调用，此时 scrollHeight 恒为 0，面板会被压成 0 高而消失。
        function calcInfoHeight(fieldCount, hasPath, collapsed) {
            if (collapsed) return INFO_HEADER_H;
            return INFO_HEADER_H + fieldCount * INFO_ROW_H + (hasPath ? INFO_PATH_ROW_H : 0) + INFO_PADDING;
        }

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: "🔄 同步预览所有视频",
                checked: VideoSyncController.enabled,
                callback: () => {
                    VideoSyncController.enabled ? VideoSyncController.disable() : VideoSyncController.enable();
                }
            });
        };

        // ────────────────────────────────────────────
        // 尺寸模型（v1.18：照 VHS「视频合成」重写，见 VHS.core.js:434/2493）
        //   画面高度 = 预览宽度 ÷ 画面宽高比 —— **推导值，不是存储值**
        //   预览区高度 = 画面 + 控制条 + 详情 + DOM 边距，报给 widget.computeSize（定高）
        //   节点高度 = 官方 LGraphNode.computeSize()，由 fitHeight 对齐（只在内容变化时）
        //
        // 方向为什么反过来了：旧版是「面板贴合节点」——弹性分支 + 拖拽中每帧钳
        //   node.size。但 VueNodes 有一条 layout → liteNode 的**单向覆盖**（GraphView
        //   的 useLayoutSync，不是取大），拖拽中钳的值下一帧就被覆盖，于是
        //   「拉长 → 画面不跟随 → 松手回弹」，补丁越加越多（节流/指针监听/宽度外推）。
        //   VHS 反过来：**节点去追面板**，且只在内容变化时对齐一次 → 冲突源不存在。
        //
        // 为什么不能再存像素高度（v1.16 及更早）：
        //   画面用 object-fit:contain 等比居中，高度一旦不等于"宽度÷比例"就是黑边——
        //   存下来的时候看着正好，换个节点宽度、换个比例的视频、换个 DPR 就全歪了。
        // ────────────────────────────────────────────

        // DOM 层实际给预览区的高度 ≠ computedHeight。
        // 官方 GraphView 里是这样摆 DOM 控件的（GraphView-*.js）：
        //     r.size[1] = (widget.computedHeight ?? 50) - margin * 2
        // 即官方在 DOM 控件四周各留一个 widget.margin（实测 = 10）的边距。
        // 漏算这 20px，容器里的画面 flex 区就比目标矮 20px，
        // object-fit:contain 立刻在**左右**补出黑边（实测 770×402，AR 1.915 vs 片源 1.8）。
        // 这里读 widget.margin 现算而不是写死 10：以后官方改默认值也不会歪。
        // DOM 层在 DOM 控件四周各让开一个 widget.margin（官方 GraphView：
        //     r.size[1] = (widget.computedHeight ?? 50) - margin * 2
        // 所以 computeSize 报的高度必须**先加回**这 2×margin，DOM 元素才会正好是
        // 「画面 + 控制条 + 详情」的高度；漏掉它 object-fit:contain 立刻补出黑边。
        // 读 widget.margin 现算而不写死 10：以后官方改默认值也不会歪。
        function domChrome(widget) {
            const m = Number(widget?.margin ?? 10) * 2;
            const el = widget?.element;
            if (!el) return m;
            // 容器自带 1px 边框且 box-sizing:border-box → 内容区比元素矮 2px，
            // 不补回来画面就差这 2px，contain 立刻补出黑边。边框只跟样式有关，
            // 量到一次就缓存；DOM 还没挂载时 offsetHeight 是 0，测出来 0 就不缓存。
            if (el._bzChrome == null && el.offsetHeight > 0) {
                el._bzChrome = Math.max(0, el.offsetHeight - el.clientHeight);
            }
            return m + (el._bzChrome || 0);
        }

        // 控制条实际占多高：它不在 widgets 数组里（是预览容器的 DOM 子元素），
        // 高度只能自己问「这一行现在渲染了吗」，不能像 _painter_info_h 那样由面板维护。
        // 写死 CONTROLS_HEIGHT 会让图片模式（控制条 display:none）的节点凭空高出 44px：
        // 画面 flex 吃掉这段多余高度 → object-fit:contain 补成上下黑边 →
        // 表现为「画面不贴节点下边框」。与「仅画面模式折叠后底部留空白」同一类根因：
        // 模型假设某行一定存在，而不是先看它到底渲染没有。
        function controlsH(widget) {
            const bar = widget?.element?.querySelector(".bz-controls-bar");
            if (!bar) return CONTROLS_HEIGHT;          // 还没建出来：先按有算，建成后 fitHeight 校正
            return bar.style.display === "none" ? 0 : CONTROLS_HEIGHT;
        }

        // 预览区总高 = 画面 + 控制条 + 详情面板 + DOM 层边距。
        // 画面高度必须是**推导值**而不是存储值：一旦落成固定像素，节点宽度一变
        // 黑边就立刻长回来。推导只依赖当前可用宽度（见 frameH），不依赖素材。
        function previewWantH(node, widget) {
            return Math.min(frameH(node, widget), MAX_PREVIEW_H)
                + controlsH(widget) + (node._painter_info_h || 0) + domChrome(widget) - WIDGET_GAP;
        }

        // 画面可用宽度**必须实测**，不能像 VHS 那样写死 `node.size[0] - 20`：
        // VHS 的容器是它自己造的，我们的是官方 .dom-widget，左右另有一层读不到常量的
        // 内缩（实测节点 270 → 容器 240、668 → 638，恒差 30，远超 2×margin）。
        // 宽度估大 → 画面高跟着估大 → 节点比面板高一截（底部空白）+ 图片左右黑边。
        //
        // 绝不缓存「宽度绝对值」：DOM 宽度是官方在节点宽度变化后的**下一帧**才写进去的，
        // 那一帧读到的仍是旧宽度，缓存下来就被永久锁死（画面高度从此算错）。
        // 只缓存「节点宽 − 容器宽」这个差值 —— 它只跟官方布局有关、与当前宽度无关，
        // 用于 DOM 还没挂载（onConfigure / 移出视口）时兜底。
        function previewContentW(node, widget) {
            const live = widget?.element?.clientWidth || 0;
            const nodeW = Math.round(node.size?.[0] || 0);
            if (live > 0) {
                if (nodeW > 0) node._bz_winset = nodeW - live;   // 只记差值，不记绝对值
                return live;   // clientWidth 已排掉 1px 边框，就是真正能画画的宽度
            }
            const inset = Number.isFinite(node?._bz_winset) ? node._bz_winset : DOM_W_INSET;
            return Math.max(0, nodeW - inset);
        }

        // 画面高度 = 可用宽度 ÷ 固定画幅比（方案 C）。
        // 不再读素材的真实宽高比：那玩意要等视频 metadata / 图片解码才有，在那之前
        // 只能占位，而节点宽度恰恰也在这段时间里变（刷新恢复、拖拽），占位高度与
        // 最终宽度对不上 → 黑边。画幅固定后高度只跟宽度走，任何时候算都是对的；
        // 非 16:9 素材由 object-fit:contain 居中留边，位置稳定、不随加载时机跳动。
        function frameH(node, widget) {
            const w = previewContentW(node, widget);
            if (w <= 0) return 0;
            return Math.round(w / FRAME_AR);
        }

        function attachPreviewLayout(node, widget) {
            // 定高分支（VHS「视频合成」同款，见 VHS.core.js:2493）。
            // 官方结算 widget 高度的地方是 `if (widget.computeSize) → 用 computeSize()[1]`，
            // 有它就走固定高度：面板高度恒等于这个值，不再随节点的富余高度浮动。
            // 高度里含 DOM 层 2×margin（domChrome），所以 DOM 元素正好是
            // 「画面 + 控制条 + 详情」，画面比例分毫不差。
            // 不再挂 computeLayoutSize：弹性分支正是「黑边」与「底部空白」的来源。
            widget.computeSize = function (width) {
                return [width, previewWantH(node, this)];
            };
            widget.computeLayoutSize = void 0;
            observeWidth(node, widget);
        }

        // 宽度是画面高度的唯一输入：容器宽度一变就必须重排，否则画面高度停在旧值。
        // 盯**元素本身**而不是「节点宽度变了才重测」—— 后者必然踩中「官方还没把新宽度
        // 写进 DOM」的那一帧（此时读到的还是旧宽度），那正是黑边的根。
        // 只认宽度变化：高度变化多半是我们自己 setSize 引起的，跟着重排会自激循环。
        function observeWidth(node, widget) {
            const el = widget?.element;
            if (!el || el._bzRO) return;
            el._bzRO = new ResizeObserver(() => {
                if (!node.graph) { el._bzRO?.disconnect(); el._bzRO = null; return; }
                const w = el.clientWidth;
                if (w > 0 && w === el._bzROLastW) return;
                el._bzROLastW = w;
                fitHeight(node);
            });
            el._bzRO.observe(el);
        }

        // 节点高度对齐内容（VHS.core.js:434 的 fitHeight，整条思路照搬）：
        // 节点高度只有一个权威 —— 官方 LGraphNode.computeSize()，它内部汇总所有
        // widget 的 computeSize 再加上标题栏等，自己按公式复算必然差几个 padding，
        // 那正是旧版「越改越歪」的来源。
        //
        // 只在**内容变化时**调用：详情面板变高、折叠切换、模式切换，以及容器宽度变化
        // （observeWidth 的 ResizeObserver）。
        // 拖拽中绝不调用 —— VueNodes 有一条 layout → liteNode 的**单向覆盖**
        // （GraphView 的 useLayoutSync，不是取大），拖的过程中抢高度必被覆盖回去，
        // 表现就是「拉长 → 画面不跟随 → 松手回弹」。VHS 从不干预拖拽，这里也一样。
        function fitHeight(node) {
            if (_bzConfiguring || !node.graph || node.flags?.collapsed) return;
            // 我们报的是**推导高度**（依赖当前容器宽度），而官方缓存的 computedHeight
            // 是它上一次布局时算的 —— 那一次往往落在「新宽度还没写进 DOM」的过渡帧上
            // （实测恒定偏宽 6px → 画面恒高 4px）。node.computeSize 不会去刷新它，
            // 所以这里必须自己先按当前真实宽度刷一遍，否则永远差那几个像素。
            const pw = node.widgets?.find(w => w.name === "painter_preview");
            if (pw?.computeSize) pw.computedHeight = pw.computeSize(node.size[0])[1];
            const h = node.computeSize?.([node.size[0], node.size[1]])?.[1];
            if (!(h > 0)) return;
            if (Math.abs(node.size[1] - h) > 1) node.setSize([node.size[0], h]);
            node.setDirtyCanvas(true, true);
        }

        // ────────────────────────────────────────────
        // 隐藏 widget 的高度归零
        // 官方 #arrangeWidgets（index-D1rfh02W.js:126195）遍历 this.widgets 时
        // 完全没有 w.hidden 判断：隐藏控件照样按 NODE_WIDGET_HEIGHT + 4
        // 计入 fixedWidgetHeight，末尾 if (y2 > bodyHeight) setSize(...) 再把节点撑回去。
        // 于是「仅画面模式」折叠后底部仍留一大片空白，且 fitHeight 收缩无效（下一帧又被撑回）。
        // 根治：让隐藏 widget 走官方「弹性分支」并被分配 0 高度。
        // 不动 widgets 数组结构 —— 避免打乱 widgets_values 的下标恢复。
        // ────────────────────────────────────────────
        function applyWidgetHiddenLayout(w, hidden) {
            if (hidden) {
                if (w._bz_size_saved) return;
                w._bz_size_saved = { cs: w.computeSize, cls: w.computeLayoutSize };
                // 定高分支：官方结算高度是 `if (w.computeSize)` 优先，所以隐藏必须落
                // 在 computeSize 上（返回 [0,-4] = 不占高度）。弹性分支那套在改用
                // VHS 机制后已不再走，但仍一并归零，免得哪条路径绕回弹性分支。
                w.computeSize = () => [0, -4];
                w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0, maxWidth: 0 });
            } else if (w._bz_size_saved) {
                w.computeSize = w._bz_size_saved.cs;   // 原值可能就是 undefined，照原样还原
                if (w._bz_size_saved.cls) w.computeLayoutSize = w._bz_size_saved.cls;
                else delete w.computeLayoutSize;
                delete w._bz_size_saved;
            }
        }

        // ────────────────────────────────────────────
        // 仅画面模式：折叠所有参数控件与详情面板，只保留视频画面
        // 状态持久化到 properties["bz_video_only"]，刷新后保持
        // ────────────────────────────────────────────
        function applyVideoOnlyMode(node, collapsed, refitSize = true) {
            node._bz_video_only = collapsed;
            if (node.properties) node.properties["bz_video_only"] = collapsed;

            node.widgets?.forEach(w => {
                if (w.name === "painter_preview" || w.type === "hidden") return;
                w.hidden = collapsed;
                applyWidgetHiddenLayout(w, collapsed);
            });

            const container = node.widgets?.find(w => w.name === "painter_preview")?.element;
            const panel = container?.querySelector(".painter-info-panel");
            if (panel) panel.style.display = collapsed ? "none" : "";
            // 面板进出布局后重算缓存高度：fitHeight 依赖它，隐藏时必须归零
            applyPanelHeight(node, panel);
            const btn = container?.querySelector(".bz-fold-btn");
            if (btn) {
                btn.textContent = collapsed ? "⌄" : "⌃";
                btn.title = collapsed ? "展开参数与详情" : "折叠参数，仅显示画面";
            }

            // 参数区/详情面板显隐切换 → 预览区高度恒定不变，节点整体高矮由官方 arrange 决定
            // （参数区隐藏则节点变矮，展开则变高，画面尺寸自始至终不动）
            if (refitSize) fitHeight(node);
        }

        // 拖拽期间**完全不干预**（VHS 同款）：高度只在内容变化时由 fitHeight 对齐一次。
        // 抢高度这条路走不通 —— VueNodes 会拿 layout.size 单向覆盖 liteNode.size
        // （不是取大），拖的过程中改的值下一帧就被覆盖，只会把「一次对齐」抖成
        // 「每帧打架」，表现为拉长 → 画面不跟随 → 松手回弹。

        nodeType.prototype.onExecuted = function (message) {
            const data = message?.painter_output?.[0];
            if (data?.filename) {
                // 本次运行产出了视频：更新预览与详情，并允许累计耗时事件更新缓存
                this._bz_run_has_output = true;
                this.properties["painter_output_cache"] = data;
                updateVideoPreview(this, data);
                if (message?.detail_info?.[0]) {
                    this.properties["detail_info_cache"] = message.detail_info[0];
                    updateInfoPanel(this, message.detail_info[0]);
                }
            } else {
                // 本次未产出视频（失败/空跑/无输入）：预览与详情面板保持原状不动
                this._bz_run_has_output = false;
            }
            this.setDirtyCanvas(true, true);
        };

        // onConfigure 的实现体：恢复工作流时节点尺寸以存档为准，期间禁止一切自动重排
        // （下方 updateInfoPanel 内部会调 fitHeight，靠这个开关挡掉）
        function configureNode(node) {
            // 提示音兜底：老工作流按位置回填 widgets_values 时，错位进来的非法值
            // （数字/乱码/别的控件的值）不能让节点在校验阶段报 "Value not in list"。
            // 归一到静音而不是 notify.mp3 —— 静音是默认值，老工作流不该突然发声。
            const sndFile = node.widgets?.find(w => w.name === "🔔 提示音文件");
            if (sndFile) {
                const opts = sndFile.options?.values || [];
                if (!opts.includes(sndFile.value)) {
                    sndFile.value = "🔇 不播放提示音";
                }
            }
            // 「🧹 出片后自动净化」是布尔控件，但删过两个参数后老工作流按位置回填，
            // 会把别的控件的值（如提示音文件名）错位到这里；字符串一律判真，
            // 表现是净化关不掉。非布尔值一律归一为「开」。
            const purgeW = node.widgets?.find(w => w.name === "🧹 出片后自动净化");
            if (purgeW && typeof purgeW.value !== "boolean") {
                purgeW.value = true;
            }
            // 帧账（帧率/帧数）先恢复：updateVideoPreview 会拿本次 data 再覆盖一次，
            // 但读档时 data 可能缺这两个字段，此时 properties 是唯一来源 ——
            // 同步预览的帧号轴没有它就是死的
            const pf = Number(node.properties?.["bz_painter_fps"]);
            const pn = Number(node.properties?.["bz_painter_frames"]);
            if (pf > 0) node._painter_fps = pf;
            if (pn > 0) node._painter_frames = pn;
            // 先恢复累计耗时（运行态数据），否则渲染详情时会因实例属性为空而跳过该行
            if (node.properties?.["bz_et_cumulative_time"]) {
                node.bz_et_formatted_cumulative_time = node.properties["bz_et_cumulative_time"];
            }
            // 画面高度不再从存档恢复：bz_preview_h 是「拖多高＝画面多高」时代的像素快照，
            // 与现代节点宽度、当前视频比例都对不上，恢复它等于把黑边请回来。
            // 现在读档后的第一帧用默认高度占位，拿到视频宽高比后 fitHeight 按真值重排。
            if (node.properties?.["painter_output_cache"]) {
                // deferred=true：恢复预览走错峰队列，不在启动早期抢连接
                updateVideoPreview(node, node.properties["painter_output_cache"], true);
            }
            if (node.properties?.["detail_info_cache"]) {
                updateInfoPanel(node, node.properties["detail_info_cache"]);
            }
            // 恢复仅画面模式（隐藏参数控件与详情面板，但保留工作流里存的节点尺寸）
            if (node.properties?.["bz_video_only"]) {
                applyVideoOnlyMode(node, true, false);
            }
        }

        // ────────────────────────────────────────────
        // 节点宽度的唯一真值 + 守卫
        //   日志实测：Alt 复制后 Vue 在拖拽结束时把副本宽度覆盖成默认 270，
        //   而高度公式以宽度为输入 → 高度 493 被重算成 275（正好一半）。
        //   VHS 节点没有这段代码，不是因为它的做法更好，而是它的高度纯由
        //   node.size[0] 推导、也没人拉宽它 —— 同样会被覆盖，只是不显眼。
        //
        //   高度是推导值，不记忆；宽度是唯一真值：非用户拖拽造成的宽度变化一律拉回。
        //   判据必须精确到「这次交互的目标是不是我」（canvas.resizing_node === node），
        //   不能用「是否在交互中」这种粗粒度状态 —— 否则用户亲手拖的边角也被推翻。
        // ────────────────────────────────────────────
        const 宽度属性名 = "bz_node_w";

        const 记宽度 = (node, w) => {
            if (!(w > 0)) return;
            node._bz_trueW = w;
            if (node.properties && node.properties[宽度属性名] !== w) {
                node.properties[宽度属性名] = w;
            }
        };

        nodeType.prototype.onResize = function (size) {
            const w = Math.round(Number(size?.[0]) || 0);
            if (w <= 0) return;
            // 用户亲手拖边角：唯一有权改宽度的入口（litegraph 在 pointer.onDragStart 里设它）
            if (app.canvas?.resizing_node === this) {
                记宽度(this, w);
                return;
            }
            // 其余来源（Vue 布局覆盖 / configure 恢复 / 折叠）一律回到真值
            const 真值 = Math.round(Number(this._bz_trueW || this.properties?.[宽度属性名] || 0));
            if (真值 > 0 && Math.abs(w - 真值) > 1 && !this._bz_fixingW) {
                this._bz_fixingW = true;
                try {
                    console.log("[BZ诊断] 宽度被覆盖", w, "→ 拉回", 真值);
                    this.setSize([真值, this.size[1]]);
                } finally {
                    this._bz_fixingW = false;
                }
            }
        };

        // Alt 复制：实例状态不随 serialize 走（_painter_field_count 等），
        // 缺一个高度就少一截，直接抄源节点。
        const _clone = nodeType.prototype.clone;
        if (typeof _clone === "function") {
            nodeType.prototype.clone = function () {
                const n = _clone.apply(this, arguments);
                if (!n) return n;
                n._painter_field_count = this._painter_field_count;
                n._painter_has_path = this._painter_has_path;
                n._painter_info_collapsed = this._painter_info_collapsed;
                n._painter_info_h = this._painter_info_h;
                n._bz_winset = this._bz_winset;
                记宽度(n, Math.round(Number(this.size?.[0]) || 0));
                return n;
            };
        }

        nodeType.prototype.onConfigure = function (info) {
            // 恢复期间一律不许自动重排改尺寸：工作流里存了多大就是多大
            _bzConfiguring = true;
            try {
                configureNode(this);
            } finally {
                _bzConfiguring = false;
            }
            // 宽度真值：properties 优先（复制与读档都带得过来），其次 info.size
            const 存档宽 = Math.round(Number(this.properties?.[宽度属性名])
                || (Array.isArray(info?.size) ? Number(info.size[0]) : 0) || 0);
            if (存档宽 > 0) {
                this._bz_trueW = 存档宽;
                if (Math.abs(this.size[0] - 存档宽) > 1) this.setSize([存档宽, this.size[1]]);
            }
            fitHeight(this);
        };

        // 节点销毁：清空 video.src / img.src，释放浏览器解码缓冲与 GPU 纹理
        // （3 路视频节点同时存活时这是内存大头；删节点不释放会一直挂着）
        nodeType.prototype.onRemoved = function () {
            try {
                const w = this.widgets?.find(x => x.name === "painter_preview");
                // 宽度观察者先断：节点已从图里摘掉，再回调 fitHeight 会去碰没有 graph 的节点
                if (w?.element?._bzRO) { w.element._bzRO.disconnect(); w.element._bzRO = null; }
                const v = w?.element?.querySelector("video");
                if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
                const im = w?.element?.querySelector("img.bz-still");
                if (im) im.removeAttribute("src");
            } catch (_) {}
        };

        // 暴露给 setup 事件监听，用于累计耗时事件到达后整体重渲染
        nodeType.prototype._bzUpdateInfoPanel = function (infoText) {
            updateInfoPanel(this, infoText);
        };

        // ────────────────────────────────────────────
        // 解析详情文本 → 结构化字段
        // 后端格式: "📂 文件名称 : value" → 在第一个冒号处切分
        // ────────────────────────────────────────────
        function parseDetailText(text) {
            const fields = [];
            const lines = text.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                // 跳过分隔线和空行
                if (/^[━─]+$/.test(trimmed) || !trimmed) continue;

                // 在第一个冒号处切分为 label 和 value
                const colonIdx = trimmed.search(/[:：]/);
                if (colonIdx > 0) {
                    const label = trimmed.substring(0, colonIdx).trim();
                    const value = trimmed.substring(colonIdx + 1).trim();
                    fields.push({ label, value });
                } else {
                    // 没有冒号的行作为纯文本
                    fields.push({ label: "", value: trimmed });
                }
            }
            return fields;
        }

        // ────────────────────────────────────────────
        // 构建信息面板 HTML
        // ────────────────────────────────────────────
        function buildInfoPanelHTML(fields) {
            const mainFields = [];
            let pathValue = "";
            const warnings = [];

            for (const f of fields) {
                if (f.label.includes("输出路径")) {
                    pathValue = f.value;
                } else if (f.label.includes("⚠") || f.label.includes("警告")) {
                    warnings.push(f.value || f.label);
                } else {
                    mainFields.push(f);
                }
            }

            let html = "";

            // --- 字段行 ---
            for (const f of mainFields) {
                html += `<div class="pi-row"><span class="pi-label">${f.label}</span><span class="pi-value">${f.value}</span></div>`;
            }

            // --- 路径行 ---
            if (pathValue) {
                html += `<div class="pi-path-row">`;
                html += `<span class="pi-path-icon" title="${pathValue}">📁</span>`;
                html += `<span class="pi-path-text">${pathValue}</span>`;
                html += `<span class="pi-path-actions">`;
                html += `<button class="pi-btn" data-action="open-folder" data-path="${pathValue}" title="打开视频所在文件夹">📂 打开目录</button>`;
                html += `</span></div>`;
            }

            // --- 警告行 ---
            for (const w of warnings) {
                html += `<div class="pi-warning">${w}</div>`;
            }

            return { html, pathValue, fieldCount: mainFields.length + (pathValue ? 1 : 0) + warnings.length };
        }

        // ────────────────────────────────────────────
        // 更新信息面板
        // ────────────────────────────────────────────
        function updateInfoPanel(node, infoText) {
            let widget = node.widgets?.find(w => w.name === "painter_preview");
            if (!widget) return;

            const container = widget.element;
            let panel = container.querySelector(".painter-info-panel");

            const fields = parseDetailText(infoText);
            node._painter_last_detail = infoText;

            // 帧率与帧数由后端随 painter_output 直给（见 updateVideoPreview）。
            // 早先从详情面板文本里正则抠「帧率」，抠不到就默认 24，各片段真实
            // 帧率不一致时同步基准整体错位。

            // 注入累计执行时间（从工作流开始到本节点完成）
            if (node.bz_et_formatted_cumulative_time) {
                fields.splice(0, 0, { label: "⏱️ 累计耗时", value: node.bz_et_formatted_cumulative_time });
            }

            const { html, pathValue, fieldCount } = buildInfoPanelHTML(fields);
            // 面板高度的推算依据：DOM 未挂载时也能算，折叠/展开复用。
            // 空详情不清零：复制/恢复时可能先来一次空文本（deferred 还原队列、
            // 执行前状态），若照它把字段数写成 0，面板高度会从约 230px 塌到 46px ——
            // 表现就是「Alt 复制出来的节点矮一半」。只在真有字段、或此前从未
            // 记录过字段数时才覆盖。
            if (fieldCount > 0 || node._painter_field_count == null) {
                node._painter_field_count = fieldCount;
                node._painter_has_path = !!pathValue;
                // 双写进 properties：实例属性不随 clone 走，properties 会。
                // 复制出来的节点靠它立刻知道该多高，不必等详情文本重新解析。
                if (node.properties && node.properties["bz_info_fields"] !== node._painter_field_count) {
                    node.properties["bz_info_fields"] = node._painter_field_count;
                    node.properties["bz_info_has_path"] = node._painter_has_path;
                }
            }

            if (!panel) {
                panel = document.createElement("div");
                panel.className = "painter-info-panel";
                panel.style.cssText = `
                    width:100%; background:#0c0c0c; border-top:1px solid #2a2a2a;
                    box-sizing:border-box; overflow:hidden; flex:0 0 auto;
                    font-family:-apple-system,'Microsoft YaHei','Segoe UI',sans-serif;
                    font-size:11px; line-height:1.4; color:#aaa;
                    user-select:text;
                `;
                container.appendChild(panel);
            }

            // --- 构建完整 HTML ---
            const collapsed = node._painter_info_collapsed || false;
            const bodyDisplay = collapsed ? "none" : "block";
            const foldIcon = collapsed ? "▸" : "▾";

            panel.innerHTML = `
                <style>
                    .pi-header {
                        height:${INFO_HEADER_H}px; display:flex; align-items:center;
                        padding:0 10px; background:#141414; gap:8px;
                        cursor:pointer; user-select:none;
                        border-bottom:1px solid #1f1f1f;
                    }
                    .pi-header:hover { background:#1a1a1a; }
                    .pi-fold-icon { font-size:10px; color:#666; width:14px; text-align:center; transition:transform 0.15s; }
                    .pi-title { flex:1; font-size:12px; color:#bbb; font-weight:500; }
                    .pi-copy-all {
                        background:none; border:none; cursor:pointer; color:#777;
                        font-size:14px; padding:0 2px; opacity:0.5; transition:opacity 0.15s;
                    }
                    .pi-copy-all:hover { opacity:1; color:#ccc; }

                    .pi-body {
                        padding:8px 12px; display:${bodyDisplay};
                    }
                    .pi-row {
                        display:flex; align-items:baseline; padding:3px 0; gap:8px;
                    }
                    .pi-label {
                        color:#777; white-space:nowrap; min-width:0; flex-shrink:0;
                    }
                    .pi-value {
                        color:#ccc; font-weight:500; word-break:break-all;
                    }
                    .pi-path-row {
                        display:flex; align-items:center; gap:6px; padding:4px 0;
                        margin-top:4px; border-top:1px solid #1f1f1f; padding-top:6px;
                        font-size:10px; color:#888;
                    }
                    .pi-path-icon { flex-shrink:0; }
                    .pi-path-text {
                        flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                    }
                    .pi-path-actions { display:flex; gap:4px; flex-shrink:0; }
                    .pi-btn {
                        background:#1e1e1e; border:1px solid #333; border-radius:3px;
                        color:#999; cursor:pointer; font-size:12px; padding:2px 6px;
                        transition:all 0.12s; line-height:1;
                    }
                    .pi-btn:hover { background:#2a2a2a; color:#ddd; border-color:#555; }
                    .pi-btn:active { background:#333; }

                    .pi-warning {
                        color:#f0a040; padding:3px 0; font-size:10px;
                    }

                    /* 跨浏览器滚动条 */
                    .pi-body::-webkit-scrollbar { width:4px; }
                    .pi-body::-webkit-scrollbar-track { background:transparent; }
                    .pi-body::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
                    .pi-body::-webkit-scrollbar-thumb:hover { background:#555; }

                    /* 复制成功提示 */
                    .pi-toast {
                        position:absolute; bottom:40px; left:50%; transform:translateX(-50%);
                        background:rgba(0,0,0,0.85); color:#4f4; padding:4px 12px;
                        border-radius:4px; font-size:11px; pointer-events:none;
                        opacity:0; transition:opacity 0.2s;
                    }
                    .pi-toast.show { opacity:1; }
                </style>
                <div class="pi-header" data-action="toggle-fold">
                    <span class="pi-fold-icon">${foldIcon}</span>
                    <span class="pi-title">📋 视频详情</span>
                    <button class="pi-copy-all" data-action="copy-all" title="复制全部">📋</button>
                </div>
                <div class="pi-body">${html}</div>
                <div class="pi-toast">✅ 已复制</div>
            `;

            // --- 事件绑定 ---
            bindPanelEvents(panel, node, infoText, pathValue);

            // 唯一画面模式下隐藏整个面板（面板可能因新事件重建，需重新应用）
            panel.style.display = node._bz_video_only ? "none" : "";
            applyPanelHeight(node, panel);

            // 详情面板高度变了 → 预览区 minHeight 随之变 → 重排让官方重新分配高度
            fitHeight(node);
        }

        // 面板高度：由 calcInfoHeight 静态推算后写回 style.height。
        // DOM 与节点布局共用同一个值，既不会留空白，也不会因实测为 0 而消失。
        function applyPanelHeight(node, panel) {
            if (!panel || panel.style.display === "none" || node._bz_video_only) {
                node._painter_info_h = 0;   // 面板不参与布局：高度不计入节点
                return;
            }
            const h = calcInfoHeight(
                // 实例属性优先，其次读 properties（复制/恢复后实例属性可能还没填）
                node._painter_field_count ?? node.properties?.["bz_info_fields"] ?? 0,
                node._painter_has_path ?? node.properties?.["bz_info_has_path"] ?? false,
                node._painter_info_collapsed
            );
            node._painter_info_h = h;
            panel.style.height = `${h}px`;
        }

        // ────────────────────────────────────────────
        // 面板交互事件
        // ────────────────────────────────────────────
        function bindPanelEvents(panel, node, infoText, pathValue) {
            // 折叠/展开
            const header = panel.querySelector(".pi-header");
            header.addEventListener("click", (e) => {
                if (e.target.closest("[data-action='copy-all']")) return;
                node._painter_info_collapsed = !node._painter_info_collapsed;
                // 重新渲染（简单切换 body 的 display）
                const body = panel.querySelector(".pi-body");
                const foldIcon = panel.querySelector(".pi-fold-icon");
                if (node._painter_info_collapsed) {
                    body.style.display = "none";
                    foldIcon.textContent = "▸";
                } else {
                    body.style.display = "block";
                    foldIcon.textContent = "▾";
                }
                // body 显示状态已改 → 面板高度随之变化 → 重排
                applyPanelHeight(node, panel);
                fitHeight(node);
            });

            // 复制全部
            const copyAllBtn = panel.querySelector("[data-action='copy-all']");
            copyAllBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                // 累计耗时是运行态数据（渲染时注入，不在 infoText 中），复制时补上
                let copyText = infoText;
                if (node.bz_et_formatted_cumulative_time) {
                    copyText = `⏱️ 累计耗时 : ${node.bz_et_formatted_cumulative_time}\n` + infoText;
                }
                navigator.clipboard.writeText(copyText).then(() => showToast(panel));
            });

            // 打开视频所在文件夹（调用后端在系统文件管理器中打开）
            panel.querySelectorAll("[data-action='open-folder']").forEach(btn => {
                btn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const p = btn.dataset.path;
                    try {
                        const resp = await api.fetchApi(`/banzhang_api/open_folder`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ path: p }),
                        });
                        const data = await resp.json();
                        if (!data?.success) showToast(panel, "❌ 打开失败");
                    } catch (err) {
                        showToast(panel, "❌ 打开失败");
                    }
                });
            });
        }

        function showToast(panel, msg = "✅ 已复制") {
            const toast = panel.querySelector(".pi-toast");
            if (!toast) return;
            toast.textContent = msg;
            toast.classList.add("show");
            clearTimeout(toast._timer);
            toast._timer = setTimeout(() => toast.classList.remove("show"), 1500);
        }

        // ────────────────────────────────────────────
        // 视频预览组件
        // ────────────────────────────────────────────
        // 恢复预览（onConfigure）的加载队列：页面刷新/读档时，工作流里的多个视频
        // 合并节点（本工作流 4 个）会同时恢复预览，各占 1 个同域连接；装了大量
        // 扩展的环境下，启动早期连接池本就被扩展 JS 下载占满，4 个视频同时加载会
        // 把连接耗尽，连带 hydrate 的 project 请求超时、段素材恢复不出来。
        // 恢复一律排队：等页面空闲后串行、错峰加载，把连接让给更关键的 hydrate；
        // 渲染完成（onExecuted）不排队，立即播放。
        const _restoreQueue = [];
        let _restoreScheduled = false;
        function queueRestore(fn) {
            _restoreQueue.push(fn);
            if (_restoreScheduled) return;
            _restoreScheduled = true;
            const pump = () => {
                const next = _restoreQueue.shift();
                if (next) {
                    try { next(); } catch (_) {}
                    setTimeout(pump, 350);   // 每段错峰，给其它请求留连接
                } else {
                    _restoreScheduled = false;
                }
            };
            const start = () => setTimeout(pump, 200);
            if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 3000 });
            else setTimeout(start, 1500);
        }

        function updateVideoPreview(node, data, deferred = false) {
            if (!data?.filename) return;  // 无有效视频数据不更新预览
            let widget = node.widgets?.find(w => w.name === "painter_preview");

            if (!widget) {
                const container = document.createElement("div");
                container.style = "position:relative; display:flex; flex-direction:column; background:transparent; overflow:hidden; width:100%; border-radius:0 0 8px 8px; border:1px solid #333; box-sizing:border-box;";
                // hideOnZoom 必须显式关掉：官方 DOM 控件默认 true，画布缩小到低画质档
                // （LOD 阈值以下）时官方层会把整个 DOM 控件隐藏（GraphView 里
                // visible = ... && !(options.hideOnZoom && lowQuality)），表现为
                // 「缩小画布后预览窗口整块消失」；官方图片/视频预览节点同样传 false
                widget = node.addDOMWidget("painter_preview", "preview", container, { hideOnZoom: false });
                attachPreviewLayout(node, widget);

                const video = document.createElement("video");
                // min-height:0 → 容器变矮时压缩画面而不是把控制条挤出容器
                video.style = "width:100%; flex:1 1 auto; min-height:0; display:block; object-fit:contain; background:#000; cursor:pointer;";
                video.loop = true;
                video.muted = true;
                // 只加载元数据+首帧，不预载全片：3 个视频合并节点同时挂时，
                // 默认 auto 会把每路视频都解码进内存（内存高、缩放重绘卡）。
                // 首帧由下方 loadedmetadata 后 seek(0.001) 触发。
                video.preload = "metadata";

                // 点击画面 = 播放/暂停意图。挂到 video 上之外还要给海报 img 挂同一份：
                // 缓冲释放后显示的是海报、video 是 display:none（收不到点击），
                // 只绑 video 就会出现「点画面没反应，先点播放按钮才行」。
                const 画面点击 = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (!video.getAttribute("src")) {
                        // 解码缓冲已被空闲释放：装回再播（海报期间点画面 = 播放意图）
                        bzEnsureVideoSrc(video, () => video.play().catch(() => {}));
                        return;
                    }
                    if (video.paused) video.play();
                    else video.pause();
                };
                video.onclick = 画面点击;
                video._bzToggle = 画面点击;

                const bar = document.createElement("div");
                bar.className = "bz-controls-bar";
                // flex:0 0 固定 → 控制条永不参与压缩，任何高度下都完整可见
                // position:relative 让饱和度弹窗以控制条为定位参照，稳稳浮在时间轴正上方
                // overflow 必须是 visible：设成 hidden 会把饱和度弹窗裁进 44px 高的控制条里
                // （且 overflow-x/y 一 hidden 一 visible 时，浏览器会把 visible 算成 auto，同样裁剪）
                bar.style = `position:relative; flex:0 0 ${CONTROLS_HEIGHT}px; height:${CONTROLS_HEIGHT}px; display:flex; align-items:center; background:rgba(20,20,20,0.95); padding:0 12px; gap:10px; color:#eee; font-size:13px; border-top:1px solid #333; box-sizing:border-box; overflow:visible; width:100%;`;

                const playBtn = document.createElement("button");
                // 预览从不自动播放（muted 自动播放会让每个节点都变成一路无限解码），
                // 初始就是暂停态，图标必须是 ▶️；真正在播时由 bzShowFrame 统一刷成 ⏸️
                playBtn.innerText = "▶️";
                playBtn.style = "background:none; border:none; cursor:pointer; font-size:18px; padding:0; display:flex; align-items:center; flex-shrink:0;";
                video._bzPlayBtn = playBtn;

                const seek = document.createElement("input");
                seek.type = "range"; seek.min = 0; seek.max = 100; seek.value = 0;
                seek.style = "flex:1; cursor:pointer; height:4px; accent-color:#666; background:#333; border-radius:2px; appearance:none; outline:none; min-width:0; margin:0;";

                const timeText = document.createElement("span");
                timeText.innerText = "0:00";
                timeText.style = "font-family:'Consolas',monospace; min-width:35px; text-align:center; color:#aaa; font-size:12px; flex-shrink:0;";

                const muteBtn = document.createElement("button");
                muteBtn.innerText = "🔇";
                muteBtn.style = "background:none; border:none; cursor:pointer; font-size:18px; padding:0; display:flex; align-items:center; flex-shrink:0;";

                video.onplay = () => { bzCancelRelease(video); bzShowFrame(video, true); playBtn.innerText = "⏸️"; };
                video.onpause = () => {
                    playBtn.innerText = "▶️";
                    if (video._bzReleased || window.VideoSyncController?.enabled) return;
                    bzReleaseVideoBuffer(video);   // 停下就交还解码缓冲，画面由当前帧顶着
                };

                playBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!video.getAttribute("src")) { bzEnsureVideoSrc(video, () => video.play().catch(() => {})); return; }
                    video.paused ? video.play() : video.pause();
                };

                video.ontimeupdate = () => {
                    if (video.duration) {
                        const per = (video.currentTime / video.duration) * 100;
                        seek.value = per;
                        const m = Math.floor(video.currentTime / 60);
                        const s = Math.floor(video.currentTime % 60);
                        timeText.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
                        seek.style.background = `linear-gradient(to right, #777 ${per}%, #333 ${per}%)`;
                    }
                };

                const 目标帧号 = () => {
                    const info = bzFrameInfo(node);
                    const total = info?.frames || Math.round((video.duration || 0) * (info?.fps || 24));
                    return Math.max(0, Math.round((Number(seek.value) / 100) * total));
                };
                seek.oninput = (e) => {
                    e.stopPropagation();
                    if (video.getAttribute("src") && !video.paused) {
                        video.currentTime = (seek.value / 100) * video.duration;
                        return;
                    }
                    const t = 目标帧号() / (bzFrameInfo(node)?.fps || 24);
                    if (video._bzReleased) video._bzReleased.t = t;   // 点播放从拖到的位置续
                    bzFetchFrame(node, video, 目标帧号(), "fast");
                };
                seek.onchange = (e) => {
                    e.stopPropagation();
                    if (video.getAttribute("src") && !video.paused) return;
                    bzFetchFrame(node, video, 目标帧号(), "full");   // 松手换原尺寸帧
                };

                muteBtn.onclick = (e) => {
                    e.stopPropagation();
                    video.muted = !video.muted;
                    muteBtn.innerText = video.muted ? "🔇" : "🔊";
                    if (!video.muted && video.volume === 0) video.volume = 1.0;
                };

                // ── 对比按钮：按住 = 「调色台点了重置」状态的画面（上次成片原样，无滤镜叠加），
                //    松开 = 恢复当前调色预览（改动量重新叠回；改动量为零时保持干净，不会双重调色）──
                const cmpBtn = document.createElement("button");
                cmpBtn.innerText = "👁";
                cmpBtn.title = "按住对比：显示成片原样（重置状态画面），松开恢复当前调色预览";
                cmpBtn.style = "background:none; border:none; cursor:pointer; font-size:16px; padding:0; display:flex; align-items:center; flex-shrink:0; opacity:0.85; border-radius:4px;";
                let _cmpOn = false;
                function setCompare(on) {
                    if (_cmpOn === on) return;   // pointerup 与 lostpointercapture 会连发，去重
                    _cmpOn = on;
                    cmpBtn.style.background = on ? "rgba(255,255,255,0.18)" : "none";
                    if (on) {
                        // 按住：干净成片画面——调色已烧进像素，滤镜必须全部摘掉
                        clearFilter();
                    } else {
                        // 松开：恢复当前调色预览（基线增量模型下天然安全）
                        refreshFilter();
                    }
                }
                // pointer capture：按住后拖出按钮再松开也能正确复位（比 mouseleave 可靠）
                cmpBtn.addEventListener("pointerdown", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    try { cmpBtn.setPointerCapture(e.pointerId); } catch (_) {}
                    setCompare(true);
                });
                cmpBtn.addEventListener("pointerup", (e) => { e.stopPropagation(); setCompare(false); });
                cmpBtn.addEventListener("pointercancel", () => setCompare(false));
                cmpBtn.addEventListener("lostpointercapture", () => setCompare(false));

                // ── 饱和度：CSS 滤镜实时生效，零重编码 ──
                const tuneBtn = document.createElement("button");
                tuneBtn.className = "bz-tune-btn";
                tuneBtn.innerText = "🎨";
                tuneBtn.title = "调色台：饱和度 / 泛光 / 柔雾 / 暖晕（拖动实时预览，点「应用并导出」直接写入本地视频）";
                tuneBtn.style = "background:none; border:none; cursor:pointer; font-size:16px; padding:0; display:flex; align-items:center; flex-shrink:0;";

                bzInjectTuneStyle();

                // 预览参数初值 = 出厂默认：节点已不再烧入调色，成片就是母版原色
                video._bz = bzTuneDefaults();
                // 上次在调色台调过的值存在节点属性里，恢复它，别让用户白调
                if (node.properties?.bz_preview_tune) {
                    BZ_TUNE_FLAT.forEach(r => {
                        video._bz[r.k] = node.properties.bz_preview_tune[r.k] ?? video._bz[r.k];
                    });
                }
                // 兼容上一版存在节点属性里的旧字段
                Object.entries(BZ_TUNE_LEGACY).forEach(([oldKey, k]) => {
                    const v = node.properties?.[oldKey];
                    if (v != null) video._bz[k] = v;
                });
                // 「基线增量」模型的基线：当前缓存成片里烧入的参数（节点不调色时即出厂默认）。
                // 滑条=基线时改动量为零、滤镜为空，预览与成片一致；拖滑条只叠加改动量
                video._bzBase = { ...video._bz };

                // 面板挂到 body：留在节点里会被画布裁掉，也做不到贴到节点旁边
                const tunePop = document.createElement("div");
                tunePop.className = "bz-tune-panel";
                tunePop.style.display = "none";
                tunePop.innerHTML = `
                    <div class="bz-tune-head">
                        <span style="font-size:13px">🎨</span>
                        <b>调色台</b>
                        <button class="bz-tune-x" data-role="close" title="关闭">✕</button>
                    </div>
                    <div class="bz-tune-body">
                        ${BZ_TUNE_SPEC.map(g => `
                        <div class="bz-grp">
                            <div class="bz-grp-t"><i style="background:${g.c}"></i>${g.g}<u></u></div>
                            ${g.rows.map(r => `
                            <div class="bz-row"><span>${r.label}</span><b data-role="v-${r.k}" style="color:${g.c}"></b></div>
                            <input class="bz-tune-range" data-role="r-${r.k}" type="range"
                                   min="${r.min}" max="${r.max}" step="${r.step || 1}" style="--c:${g.c}">
                            `).join("")}
                        </div>`).join("")}
                    </div>
                    <div class="bz-tune-foot">
                        <button class="bz-btn" data-role="reset" title="恢复出厂默认">重置</button>
                        <button class="bz-btn main" data-role="apply" title="把当前调色直接写进本地视频，不经过 ComfyUI 运行队列">应用并导出</button>
                    </div>
                    <div class="bz-tune-msg" data-role="msg"></div>
                `;
                document.body.appendChild(tunePop);

                const tuneUI = {};
                BZ_TUNE_FLAT.forEach(r => {
                    tuneUI[r.k] = {
                        spec: r,
                        valEl: tunePop.querySelector(`[data-role="v-${r.k}"]`),
                        rangeEl: tunePop.querySelector(`[data-role="r-${r.k}"]`),
                    };
                });

                function showMsg(text, color) {
                    const m = tunePop.querySelector('[data-role="msg"]');
                    m.textContent = text;
                    m.style.color = color;
                }

                // 面板底部常显当前调色数值（= 点「应用并导出」最终会写进视频的那套值）
                function syncTuneMsg() {
                    const g = (k) => video._bz?.[k] ?? 0;
                    showMsg(`当前 饱和 ${Math.round(g("sat") * 100)}% · 泛光 ${Math.round(g("bloom") * 100)}%`
                          + ` · 柔雾 ${Math.round(g("soft") * 100)}% · 暖晕 ${Math.round(g("warm") * 100)}%`, "#8a8a92");
                }

                // 预览被改过但还没「应用并导出」时，用醒目的黄字提醒：不导出，成片不会变
                let _dirty = false;
                function markUnsaved(on = true) {
                    _dirty = on;
                    if (on) {
                        showMsg("⚠️ 预览 = 当前成片画面 + 本次改动量的近似叠加；点「应用并导出」后预览即与成片一致", "#f0c674");
                    } else {
                        syncTuneMsg();
                    }
                }

                // ── 调色预览：「基线增量」模型 ──
                // 预览源是已烧入基线参数的成片，滤镜只能叠加「滑条相对基线的改动量」：
                // 滑条=基线 → 增量为零 → 滤镜为空 → 预览与成片逐像素一致（双重调色的根治方案）；
                // 拖滑条 → 只把改动量叠上去，实时看到「这次调了多少」。只影响预览，绝不写节点控件。
                function refreshFilter() {
                    const cur = video._bz || bzTuneDefaults();
                    const base = video._bzBase;
                    const d = base ? {
                        sat: cur.sat / Math.max(0.05, base.sat || 1),   // 饱和度用比值，升/降都能近似
                        bloom: Math.max(0, cur.bloom - (base.bloom || 0)),
                        warm: Math.max(0, cur.warm - (base.warm || 0)),
                        soft: Math.max(0, cur.soft - (base.soft || 0)),
                        haze: Math.max(0, cur.haze - (base.haze || 0)),
                    } : {
                        sat: cur.sat, bloom: cur.bloom, warm: cur.warm, soft: cur.soft, haze: cur.haze,
                    };
                    const f = bzFilterCss(node.id, {
                        ...d,
                        bloomThr: cur.bloomThr, bloomRad: cur.bloomRad,
                        warmThr: cur.warmThr, warmRad: cur.warmRad,
                        softRad: cur.softRad,
                        width: video.clientWidth || video.videoWidth || 400,
                    });
                    video.style.filter = f;
                    // 只有真有滤镜内容才算「叠加改动量」状态（改动量为零时 f 是空串）
                    video._bzFilterOn = !!f;
                    const still = widget.element.querySelector("img.bz-still");
                    if (still) still.style.filter = f;
                }

                // 新成片到达时必须清滤镜：调色已经烧进视频像素里，再叠一遍就是双重调色
                // ——这正是「节点预览比播放器里的成片浓一倍」的根源。清掉后预览与成片一致，
                // 只有用户在调色台里改动参数时才重新叠滤镜做「改动量预览」。
                function clearFilter() {
                    video.style.filter = "";
                    video._bzFilterOn = false;
                    const still = widget.element.querySelector("img.bz-still");
                    if (still) still.style.filter = "";
                }
                // 换源分支在闭包外执行，把清理函数挂到 video 元素上供其调用
                video._bzClearFilter = clearFilter;

                function syncRow(k) {
                    const { spec, valEl, rangeEl } = tuneUI[k];
                    const v = video._bz[k];
                    valEl.textContent = spec.scale === 1 ? String(v) : Math.round(v * spec.scale) + spec.unit;
                    rangeEl.value = String(v * spec.scale);
                    rangeEl.style.setProperty("--p", ((v * spec.scale - spec.min) / (spec.max - spec.min) * 100).toFixed(1) + "%");
                }

                // 改任一参数：只更新预览画面 + 面板数字，绝不写节点控件
                function setTune(k, v) {
                    video._bz[k] = v;
                    syncRow(k);
                    refreshFilter();
                    markUnsaved();
                }

                BZ_TUNE_FLAT.forEach(r => {
                    tuneUI[r.k].rangeEl.addEventListener("input", (e) => {
                        e.stopPropagation();
                        setTune(r.k, parseFloat(e.target.value) / r.scale);
                    });
                });

                // ── 贴到节点旁边：DOM 小部件浮在画布上层，节点在被缩放/平移的画布里，
                // 只能按画布变换换算屏幕坐标；右边放不下就贴左边。画布一动就跟着走 ──
                let followRaf = 0;
                function placeTunePop() {
                    // 直接用节点的屏幕坐标：ComfyUI 节点 DOM 本身就在画布图层里，
                    // getBoundingClientRect 拿到的就是它最终显示的位置，不用自己拿 ds 换算
                    // （自算 scale/offset 会因为画布缩放系数、工具栏高度、滚动等对不齐，错位就是这么来的）
                    const el = widget.element;
                    if (!el || !el.isConnected) return;
                    const nr = el.getBoundingClientRect();
                    // 面板跟着画布一起缩放：画布放大节点变大，面板也同步放大，视觉比例一致
                    const sc = app.canvas?.ds?.scale || 1;
                    tunePop.style.transformOrigin = "top left";
                    tunePop.style.transform = `scale(${sc})`;
                    const pw = (tunePop.offsetWidth || 238) * sc;
                    const ph = (tunePop.offsetHeight || 320) * sc;
                    const gap = 8 * sc;
                    let x = nr.right + gap;                                   // 默认贴节点右侧
                    if (x + pw > window.innerWidth - 4) x = nr.left - pw - gap; // 右边放不下改贴左侧
                    x = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - pw - 4));
                    let y = Math.min(nr.top, Math.max(4, window.innerHeight - ph - 4));
                    tunePop.style.left = Math.round(x) + "px";
                    tunePop.style.top = Math.round(Math.max(4, y)) + "px";
                }
                function startFollow() {
                    if (followRaf) return;
                    const tick = () => {
                        // 节点被删了就收摊：停循环、摘监听、移除面板，避免残留
                        if (!app.graph.getNodeById(node.id)) {
                            followRaf = 0;
                            tunePop._bzCleanup?.();
                            return;
                        }
                        if (tunePop.style.display === "none") {
                            followRaf = 0;
                            return;
                        }
                        placeTunePop();
                        followRaf = requestAnimationFrame(tick);
                    };
                    followRaf = requestAnimationFrame(tick);
                }
                const onDocDown = (e) => {
                    if (tunePop.style.display !== "block") return;
                    if (tunePop.contains(e.target) || tuneBtn.contains(e.target)) return;
                    tunePop.style.display = "none";
                };
                document.addEventListener("mousedown", onDocDown, true);
                tunePop._bzCleanup = () => {
                    document.removeEventListener("mousedown", onDocDown, true);
                    tunePop.remove();
                };

                tuneBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (tunePop.style.display === "block") {
                        tunePop.style.display = "none";
                        return;
                    }
                    if (_dirty) markUnsaved(true); else syncTuneMsg();
                    tunePop.style.display = "block";
                    placeTunePop();
                    startFollow();
                };
                tunePop.querySelector('[data-role="close"]').onclick = (e) => {
                    e.stopPropagation();
                    tunePop.style.display = "none";
                };

                tunePop.querySelector('[data-role="reset"]').addEventListener("click", (e) => {
                    e.stopPropagation();
                    // 重置 = 全参数回出厂默认（滑条归零，预览滤镜清空）
                    video._bz = bzTuneDefaults();
                    BZ_TUNE_FLAT.forEach(r => syncRow(r.k));
                    refreshFilter();
                    markUnsaved(false);
                    showMsg("已恢复出厂默认", "#8a8a92");
                });

                // 「应用并导出」：把当前调色直接烘进本地源视频。
                // 全程不进 ComfyUI 执行队列——不重跑上游节点、不写入任何节点控件，
                // 因此反复调色导出既快，也不会把参数焊死在节点上。
                tunePop.querySelector('[data-role="apply"]').addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const btn = tunePop.querySelector('[data-role="apply"]');
                    if (btn.disabled) return;

                    // 数据源用母版路径（成片在磁盘上的位置）；兜底从预览地址里抠 path 参数
                    const master = video._bzMaster || (() => {
                        const m = (video.src || "").match(/[?&]path=([^&]+)/);
                        return m ? decodeURIComponent(m[1]) : "";
                    })();
                    if (!master) {
                        showMsg("⚠️ 找不到源视频文件：请先运行一次工作流生成成片，再回来调色", "#f0a0a0");
                        return;
                    }

                    // 面板参数名 → 后端调色键名，后端按 TUNE_DEFAULTS 的键取值
                    const tune = {};
                    BZ_TUNE_FLAT.forEach(r => { tune[r.w] = video._bz[r.k]; });

                    const 原按钮文字 = btn.textContent;
                    btn.disabled = true;
                    btn.textContent = "导出中…";
                    showMsg("正在把调色写入视频，请稍候…", "#f0c674");

                    // 进度订阅：后端广播 → _bakeWatch → 按钮文字
                    _bakeWatch = { src: master, done: 0, total: 0 };
                    const 进度计时器 = setInterval(() => {
                        if (!_bakeWatch) return;
                        const { done, total } = _bakeWatch;
                        const pct = total > 0 ? Math.min(99, Math.round(done / total * 100)) : 0;
                        btn.textContent = pct > 0 ? `导出中 ${pct}%` : "导出中…";
                    }, 200);
                    try {
                        const resp = await api.fetchApi("/banzhang_api/bake_video", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ src: master, tune: tune }),
                        });
                        // 先把响应文本读出来，能定位问题：404 时 ComfyUI 返回的是 HTML，
                        // resp.json() 会抛难懂的 JSON 解析错误
                        const text = await resp.text();
                        let r;
                        try {
                            r = JSON.parse(text);
                        } catch (e) {
                            showMsg(`❌ 接口未就绪（HTTP ${resp.status}）。请完全退出 ComfyUI 再重启，新接口才生效`, "#f0a0a0");
                            return;
                        }
                        if (!r.success) {
                            showMsg("❌ " + (r.msg || "导出失败"), "#f0a0a0");
                            return;
                        }
                        // 新成片已把调色烧进像素：基线归位到当前滑条值，改动量清零，预览与成片一致
                        video._bzBase = { ...video._bz };
                        if (typeof video._bzClearFilter === "function") video._bzClearFilter();
                        if (r.fps) node._painter_fps = r.fps;
                        if (r.frame_count) node._painter_frames = r.frame_count;
                        // 走统一入口：清掉可能存在的「已释放」状态，否则点播放会用旧片源盖回新成片
                        bzSetVideoSrc(video, api.apiURL(`/banzhang_api/video_file?path=${encodeURIComponent(r.path)}&t=${Date.now()}`));
                        bzShowFrame(video, true);   // 海报让位给画面
                        video.play().catch(() => {});
                        _dirty = false;
                        showMsg("✅ 已导出到源文件旁：" + r.filename, "#8ad4a8");
                        node.setDirtyCanvas(true, true);
                    } catch (err) {
                        showMsg("❌ 导出请求失败：" + err, "#f0a0a0");
                    } finally {
                        clearInterval(进度计时器);
                        _bakeWatch = null;
                        btn.disabled = false;
                        btn.textContent = 原按钮文字;
                    }
                });

                // 恢复上次调过的值（节点属性随工作流保存）
                BZ_TUNE_FLAT.forEach(r => syncRow(r.k));
                refreshFilter();

                video.onloadedmetadata = () => {
                    // 节点尺寸不随视频变：视频已用 object-fit:contain 自适应预览区，
                    // 此处只负责在「叠加改动量」状态下按真实宽度重算滤镜（模糊半径与预览宽度成比例）；
                    // 干净状态（改动量为零）不自动叠滤镜，避免双重调色
                    if (video._bzFilterOn) refreshFilter();
                    // 不再在这里重排：画面高度只跟容器宽度走（固定画幅），宽度由
                    // observeWidth 的 ResizeObserver 盯着，素材加载完无需再动高度。
                };

                // 折叠按钮：仅画面模式开关（悬浮在视频右上角，状态持久化）
                const foldBtn = document.createElement("button");
                foldBtn.className = "bz-fold-btn";
                foldBtn.textContent = node._bz_video_only ? "⌄" : "⌃";
                foldBtn.title = node._bz_video_only ? "展开参数与详情" : "折叠参数，仅显示画面";
                foldBtn.style = "position:absolute; top:8px; right:10px; z-index:20; background:rgba(0,0,0,0.45); border:1px solid rgba(255,255,255,0.18); border-radius:4px; color:#ccc; cursor:pointer; font-size:13px; line-height:1; padding:4px 8px;";
                foldBtn.onclick = (e) => {
                    e.stopPropagation();
                    applyVideoOnlyMode(node, !node._bz_video_only);
                };

                bar.append(playBtn, seek, timeText, muteBtn, cmpBtn, tuneBtn);
                container.append(video, bar, foldBtn);

                // 预览区刚诞生：节点还没为它留位置，重排一次让它长到能装下画面。
                // 刷新恢复路径上 fitHeight 会被 _bzConfiguring 挡掉 → 存档尺寸原样保留。
                fitHeight(node);
            }

            const v = widget.element.querySelector("video");
            const bar = widget.element.querySelector(".bz-controls-bar");
            // 帧率与帧数取后端真值，同步预览按帧号寻址全靠它。
            // 双写 properties：实例属性不随工作流走，刷新后只剩默认值，
            // 30fps 的片源会被当 24fps 算，整条帧号轴错位。
            if (data.fps) {
                node._painter_fps = data.fps;
                if (node.properties) node.properties["bz_painter_fps"] = data.fps;
            }
            if (data.frame_count) {
                node._painter_frames = data.frame_count;
                if (node.properties) node.properties["bz_painter_frames"] = data.frame_count;
            }
            // 自定义路径保存时 output 无文件，走后端接口直接读取；否则走 /view
            const src = data.abs_path
                ? api.apiURL(`/banzhang_api/video_file?path=${encodeURIComponent(data.abs_path)}&t=${Date.now()}`)
                : api.apiURL(`/view?filename=${data.filename}&subfolder=${data.subfolder}&type=${data.type}&t=${Date.now()}`);

            // 图片模式：本次产出是 PNG/JPG，<video> 放不出来，改为渲染 <img>
            const isImage = /\.(png|jpe?g|webp)$/i.test(data.filename || "");
            let img = widget.element.querySelector("img.bz-still");
            // 新画面到达：成片不再由节点烧入调色，基线即出厂默认。
            // 此后滑条只要等于基线，改动量就是零、滤镜为空，预览与成片逐像素一致；
            // 拖动滑条时只叠加「改动量」，从根上杜绝「成片+完整滤镜」的双重调色
            {
                if (v) v._bzBase = bzTuneDefaults();
                // 母版路径 = 这份成片在磁盘上的真实位置。后续每次「应用并导出」都基于它重算，
                // 因此反复调色不会叠加上一次的结果（非破坏性，调多少次都回得去）。
                // 注意：导出后不更新它——母版始终是节点产出的那一份。
                if (v && data.src_path) v._bzMaster = data.src_path;
            }
            if (isImage) {
                if (!img) {
                    img = document.createElement("img");
                    img.className = "bz-still";
                    img.style = "width:100%; flex:1 1 auto; min-height:0; display:block; object-fit:contain; background:#000;";
                    // 不在 onload 里重排：画幅固定，图片比例不参与高度计算
                    widget.element.insertBefore(img, widget.element.firstChild);
                }
                img.style.display = "block";
                // 海报/静图模式标记：bzShowFrame 见到它就绝不切换显示，
                // 避免把「图片模式的正式内容」当临时海报藏掉
                img._bzIsStillMode = true;
                // 恢复时延迟加载图片（错峰，避免占连接），渲染完成立即
                const loadStill = () => { img.src = src; };
                if (deferred) queueRestore(loadStill); else loadStill();
                // 图片模式：产出的图已烧入调色，预览不能叠滤镜（与视频分支同理）
                img.style.filter = "";
                if (v) v._bzFilterOn = false;
                if (v) v.style.display = "none";
                if (bar) bar.style.display = "none";
            } else {
                if (img) img.style.display = "none";
                // 恢复必须写回明确值（video=block / bar=flex），清空会把原内联样式一并抹掉，
                // 控制条会退化成 block 导致按钮竖着堆叠
                if (v) v.style.display = "block";
                if (bar) bar.style.display = "flex";
                // 清滤镜（不依赖 src，先做）：新成片已把调色烧进像素，预览绝不能再叠
                // 一遍滤镜，否则预览=成片+滤镜（双重调色）、播放器里看成片永远比节点
                // 预览淡一半。只有在调色台里改动参数时才叠加滤镜做「改动量预览」。
                if (typeof v._bzClearFilter === "function") v._bzClearFilter();
                else { v.style.filter = ""; v._bzFilterOn = false; }
                // 恢复时延迟加载视频（错峰，避免占连接），渲染完成立即
                const loadVideo = () => {
                    bzSetVideoSrc(v, src);
                    // 不自动播放：video 是 muted 的，浏览器对静音视频直接放行自动播放，
                    // 画布上每个视频合并节点就是一路 loop 无限解码（实测 3 个节点空闲
                    // CPU 148%）。预览只需首帧，点画面才播（onclick 已接）。
                    const 截首帧并释放 = () => {
                        // 图片模式的 img 是正式内容，绝不能被当成静态帧顶掉
                        let img = widget.element.querySelector("img.bz-still");
                        if (img && img._bzIsStillMode) return;
                        if (!img) {
                            img = document.createElement("img");
                            img.className = "bz-still";
                            img.style = "width:100%; flex:1 1 auto; min-height:0; display:block; object-fit:contain; background:#000; cursor:pointer;";
                            img.onclick = v._bzToggle || null;
                            widget.element.insertBefore(img, widget.element.firstChild);
                        }
                        bzReleaseVideoBuffer(v);   // 内部截当前帧（首帧）后立刻交还解码缓冲
                    };
                    const 显首帧 = () => {
                        try {
                            v.pause();
                            if (v.currentTime === 0) v.currentTime = 0.001; // seek 一下才渲染首帧
                        } catch (_) { /* 尚不可 seek，等下一次事件 */ }
                        // 截图必须等 seek 落地，否则画到的是上一帧
                        if (v.seeking) v.addEventListener("seeked", 截首帧并释放, { once: true });
                        else 截首帧并释放();
                    };
                    if (v.readyState >= 1) 显首帧();
                    else v.addEventListener("loadedmetadata", 显首帧, { once: true });
                };
                if (deferred) queueRestore(loadVideo); else loadVideo();
            }

            node.setDirtyCanvas(true, true);
        }
    }
});
