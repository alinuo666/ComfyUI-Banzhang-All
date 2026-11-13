# Changelog · 更新日志

## v2.1.1 — 2026-11-12

- First public release: 100 nodes（首次公开版本：100 个节点）
- Fixed: `core/` subpackage was missing from the release, which made 6 CGlide nodes（Director Studio, Media Rack, Desk, Tail Ref, Join, Legacy Director）fail to load as a group（修复：发布包缺 `core/` 子包，导致导演台、媒体架、文案台、参照图替换、续接合成、经典版导演台整组加载失败）
- Release integrity: a relative-import completeness check now blocks any release that is missing referenced modules or directories（发布完整性：新增相对导入完整性检查，缺被引用的模块/目录会拒绝发布）
- Retired 7 node groups: Topaz Starlight, H3 Clip Archive, Veda sparse attention, H3 Tweaks, Universal Slider, Ignore Groups, Color Picker（注销 7 组节点：Topaz 星光、H3 续拍存档、Veda 稀疏注意力、H3 画面微调、万能滑条、忽略多组、取色器）
- RelayVSR: downstream-consumer detection — errors are only raised when a downstream node actually consumes the output（RelayVSR：新增下游消费检测，仅在下游真的接线时才报错）
- README: model mirror on Quark netdisk added; bilingual README and this changelog（README 增加模型网盘链接；改为中英双语并新增更新日志）
