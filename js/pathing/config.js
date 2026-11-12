// 走线参数。运行时可在控制台改 window.__pcb.conf.* 后调用 window.__pcb.invalidate()
// 让下一帧重算；未做设置面板 -- ComfyUI 的 setting 注册 API 在版本间不统一
// (registerExtension.settings vs app.ui.settings.addSetting)，接错就是整块静默失效。
//
// 改动这些值会改变走线几何：invalidate() 清缓存并强制重提障碍物快照。
export const conf = {
  widthScale: 0.5, // 线宽 = 核心 connections_width * 此值（0.5 -> 1.5px @ 默认 3）
  radius: 10, // 拐角圆角半径（trace.js 会按相邻段长的 1/3 收敛）
  clearance: 16, // 障碍物外扩间距
  vPad: 8, // 水平走线额外避开的高度，给节点投影留位
  stub: 24, // 引脚出线直段长度
  stubPitch: 5, // 同侧引脚阶梯间距（须 < nudge 的 CLUSTER，否则会被重新摊开）
  lane: 8, // 并行走线间距
  avoidGroups: true // 节点组框是否作为障碍（否则走线会横穿组标题栏）
}
