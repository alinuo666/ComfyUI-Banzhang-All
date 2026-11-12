/* ============================================================
 * 段长换算：生成总长 ↔ 净长 ↔ H3 合法格点
 * ------------------------------------------------------------
 * 导演台（csglide_cast_*）与成片监视器（csglide_film.js）共用这一份。
 * 本文件零 import、零 DOM、不碰节点状态：film.js 不能引 cast_core.js
 * （core.js 反向 re-export 了 film.js 的颜色常量，会成环），换算只能单独成模块。
 * ============================================================ */

export const FRAME_MIN = 5, FRAME_BASE = 5, FRAME_GRID = 17, FRAME_MAX = 719;

/* 最近的 17k+5 帧。alignFrames（在 cast_core.js）只往上顶，用在「已有帧数、
   把它顶到合法」的地方；自定义时长是「用户报一个值、吸附到最近的合法格」，
   方向该由远近决定。上下按钮每次只改 1 秒，一律往上顶会一次跨两格
   （141 帧 5.88s 按上 → 165 帧再顶到 175），取最近格点才是一格（→158）。 */
export const nearestFrames = (n) =>
  FRAME_BASE + FRAME_GRID * Math.max(0, Math.round(
    (Math.max(FRAME_MIN, Math.round(n)) - FRAME_BASE) / FRAME_GRID));

/* 档案 frames 与 st.length 只存**生成总长**（后端按它采样）；时间轴块宽、
   设置卡秒框/滑块、监视器底栏一律报**净长**。以前三处各写一遍 ±trim 和吸附，
   改一处忘两处，就出现「拖的和输入的不一致」。这里只吸一次格点并夹 719：
   先吸净长再吸总长会漂移半格（两次取整）。 */
export const netOfTotal = (total, trim) =>
  Math.max(1, Math.round(Number(total) || 0) - Math.max(0, Math.round(Number(trim) || 0)));
export const totalOfNet = (net, trim) =>
  Math.min(FRAME_MAX, nearestFrames(
    Math.round(Number(net) || FRAME_MIN) + Math.max(0, Math.round(Number(trim) || 0))));

/* 秒数显示统一取整：导演台时长框、指挥条、成片监视器段块标签与拖动气泡共用。
   接续段必须先由 netOfTotal 扣掉承接重叠再取整 —— 拿生成总长取整会比设置卡
   多显示一段重叠（实测 56 帧约 2 秒）；两端各写一遍取整也会让同一帧数显示成
   两个不同的数。帧数真值与 title 里的精确秒数都不走这里，只换显示字符串。 */
export const secsIntOfFrames = (netFrames, fps = 24) =>
  String(Math.round(netFrames / (Number(fps) > 0 ? Number(fps) : 24)));
