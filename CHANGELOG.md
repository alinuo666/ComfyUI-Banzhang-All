# Changelog · 更新日志

## 2026-11-13

- New: H3 Image image-model support in the Image Studio — video-latent static-frame channel layout (24ch, 5-dim with T=1). The prompt-rewrite path needs an external text model (same mechanism as the Desk).
- 新增：图像编辑台支持 H3 Image 图像模型 —— 视频潜空间静态帧通道（24 通道、5 维含 T=1）；提示词改写需外接独立文本模型（同文案台机制）。
- Asset pool identity migrated from alias to content hash (SQLite schema v5, idempotent self-check with automatic backfill and rebuild).
- 素材池身份从 alias 迁移到内容哈希（数据库 schema v5，幂等自检，自动补填与重建）。
- Media Rack fallback: when no Desk is on the canvas, the Image Studio now reads the prompts fed by the Media Rack.
- 媒体架兜底：画布上没有文案台时，图像编辑台改读媒体架喂入的提示词。
- Media Rack drag-sort and reference feeding improvements; new hash selftest for the asset pool.
- 媒体架拖拽排序与引用喂入优化；素材池新增哈希自测。

## v2.1.1 — 2026-11-12

- First public release: 100 nodes.
- 首次公开版本：100 个节点。
- Fixed: `core/` subpackage was missing from the release, which made 6 CGlide nodes (Director Studio, Media Rack, Desk, Tail Ref, Join, Legacy Director) fail to load as a group.
- 修复：发布包缺 `core/` 子包，导致导演台、媒体架、文案台、参照图替换、续接合成、经典版导演台整组加载失败。
- Release integrity: a relative-import completeness check now blocks any release that is missing referenced modules or directories.
- 发布完整性：新增相对导入完整性检查，缺被引用的模块/目录会拒绝发布。
- Retired 7 node groups: Topaz Starlight, H3 Clip Archive, Veda sparse attention, H3 Tweaks, Universal Slider, Ignore Groups, Color Picker.
- 注销 7 组节点：Topaz 星光、H3 续拍存档、Veda 稀疏注意力、H3 画面微调、万能滑条、忽略多组、取色器。
- RelayVSR: downstream-consumer detection — errors are only raised when a downstream node actually consumes the output.
- RelayVSR：新增下游消费检测，仅在下游真的接线时才报错。
- Model mirror on Quark netdisk added to the README.
- README 增加模型网盘链接。
- Bilingual README (English / Chinese) and this changelog.
- README 改为英文／中文双语，并新增本更新日志。
