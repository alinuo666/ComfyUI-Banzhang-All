# 第三方组件与许可说明

本包整合了多个上游开源项目。下表依据各文件头部注释与目录内自带许可证整理；标「待核实」的项目尚未逐一比对上游仓库，如信息有误请开 Issue，我会立即更正或移除。

| 组件 | 位置 | 许可 | 状态 |
|---|---|---|---|
| ComfyUI-H3-Motion-Context | `_h3mc/` | GPLv3 | 目录内保留原 `LICENSE` / `README` / `pyproject.toml` |
| FlashVSR、SageAttention / Sparse_SageAttention_API | `_flashvsr/` | Apache-2.0 | 目录内保留原 `LICENSE.txt` |
| EMA-VFI（MCG-NJU） | `_ema_vfi/` | Apache-2.0 | 代码注释自述 |
| RelayVSR / LightX2V | `_relayvsr/` | Apache-2.0 | 代码注释自述 |
| ComfyUI-MAINodes Dials | `_mainodes_dials/` | GPL-3.0 | 目录内保留原 `LICENSE-GPL-3.0.txt` |
| RIFE（ECCV2022）、ComfyUI-KJNodes、RES4LYF、ComfyUI-ClipProj、Fizgig-H3-Tweaks、ComfyUI-RH-DLSS5 | 根目录若干 `.py` | MIT | 代码注释自述 |
| ComfyUI_Nvidia_VFX_Nodes、Gen-L-Video temporal co-denoising | 根目录若干 `.py` | Apache-2.0 | 代码注释自述 |
| SelfLift / SelfLift-Avatar、Veda-sparse、SLA、ComfyUI-CGlide、Goohaitools、ComfyUI-Dev-Utils、MiniMax H3 相关合并节点 | `_selflift_avatar/`、`selflift/`、`sla/`、`csglide_*.py` 等 | **待核实** | 上游来源与许可尚未逐一确认 |

## 不随本仓库分发的内容

- MiniMax H3 社区许可的模型衍生权重（`dials/*.safetensors` 等）
- NVIDIA / Topaz 专有引擎与二进制、FFmpeg 可执行文件
- 字体文件、内部开发日志、AI 协作指令、备份与自测脚本

## 署名

若您是上表任一上游作者，认为署名、许可标注或代码使用方式需要调整，请在 Issues 里说明，我会第一时间处理。
