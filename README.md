[English](#english) | [中文](#中文)

# English

A Chinese-language ComfyUI custom node pack for video generation with the MiniMax H3 model. Built around the "three-pass" workflow — high-definition video even on a 6 GB GPU.

Includes multi-segment continuation, Director Studio, the AI Producer Hub, pin-frame drift control, VRAM management, plus text and subtitle tools.

## Support the Author

If this pack saves you time, buying the author a coffee is always appreciated — entirely optional, and it unlocks nothing extra.

The codes below are **donation QR codes**; the WeChat QR code in "Contact & Updates" is for adding friends — they are different.

<table>
  <tr>
    <td align="center">WeChat Pay<br><a href="wechat-reward.png"><img src="wechat-reward.png" width="200" alt="WeChat Pay"></a></td>
    <td align="center">Alipay<br><a href="alipay-reward.jpg"><img src="alipay-reward.jpg" width="200" alt="Alipay"></a></td>
  </tr>
</table>

## Installation

1. Put this repository into `ComfyUI/custom_nodes/ComfyUI-Banzhang-All`.
2. **Fully restart ComfyUI** (refreshing the web page is not enough). If files under `js/` were changed, press `Ctrl+F5` as well.
3. Python dependencies: see `requirements.txt`.

## UI Preview

**H3 Director Studio**: multi-segment continuation, final-film monitor, timeline and parameters in one place.

<a href="director-studio.jpg"><img src="director-studio.jpg" width="560" alt="H3 Director Studio"></a>

**H3 Desk + Media Rack**: segmented script editing and reference asset management.

<a href="desk-media-rack.png"><img src="desk-media-rack.png" width="560" alt="H3 Desk & Media Rack"></a>

**Music-video production**: 4-segment continuation with audio waveform alignment, beat-based shot planning and per-segment preview.

<a href="mv-studio.png"><img src="mv-studio.png" width="560" alt="MV production"></a>

## External Components & Licenses

- **Model mirror (Quark netdisk)**: the author keeps all models required by this pack in one place, ready to download:
  [https://pan.quark.cn/s/70186cdde3ab?pwd=Lqse](https://pan.quark.cn/s/70186cdde3ab?pwd=Lqse) (extraction code included in the link).
- **ComfyUI-H3-Motion-Context** (GPLv3): Director Studio's latent-continuation math, tensor slicing and grid checks depend on it. A copy ships in `_h3mc/` under its own `LICENSE`; replace it with an upstream update if needed.
- **MiniMax H3 model weights** (MiniMax H3 Community License, with territory and revenue restrictions), **NVIDIA VFX / DLSS / Topaz proprietary engines and binaries**, and **fonts** are not distributed with this repository; obtain them under their own licenses. Related nodes stay inactive without those engines.

## License

This repository is released under **GPL-3.0-or-later**; see `LICENSE` for the full text.

Sources and licenses of bundled third-party components are listed in `NOTICE.md`; upstream `LICENSE` / `NOTICE` files are kept inside each vendored directory.

## Commercial Use

This repository is provided under GPL-3.0-or-later; GPL-compliant use needs no further contact.

**Content you create with this pack is yours to monetize** — short dramas, ads, music videos, commissions, platform revenue. Such videos, images and audio are your own works, not bound by the GPL: **no extra license, no payment required**. The GPL governs how the code is distributed, not how the output is used.

The only case needing a separate agreement: bundling the code (or a modified version) **into your own closed-source software or product for distribution or sale** while keeping changes private. Reach the author via GitHub Issues or the WeChat QR code below.

Note: model weights carry their own license — the MiniMax H3 Community License has territory and revenue thresholds; confirm before commercial use. Third-party components listed in `NOTICE.md` (notably `_h3mc/`, GPLv3) are outside this authorization and keep their own terms.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Contact & Updates

- Bilibili: [Banzhang captain](https://space.bilibili.com/15838129?spm_id_from=333.788.0.0)
- WeChat: scan the QR code below to add the author as a friend.

<a href="wechat-qr.png"><img src="wechat-qr.png" width="285" alt="WeChat QR"></a>

## Feedback

Please open a GitHub Issue and include your ComfyUI version plus the last lines of the terminal log.

---

# 中文

一个面向 MiniMax H3 视频模型视频生成的 ComfyUI 中文插件。主打三采工作流，6GB 显存也能跑高清视频。

内置多段续写、导演台、AI 制片中枢、钉帧漂移控制、显存管理、文本与字幕工具。

## 支持一下

如果这套节点省了时间，欢迎请作者喝杯咖啡。完全自愿，与功能无关。

下面是**打赏码**；后文「联系与更新」里的微信二维码用于加好友，两者不同。

<table>
  <tr>
    <td align="center">微信支付<br><a href="wechat-reward.png"><img src="wechat-reward.png" width="200" alt="微信支付"></a></td>
    <td align="center">支付宝<br><a href="alipay-reward.jpg"><img src="alipay-reward.jpg" width="200" alt="支付宝"></a></td>
  </tr>
</table>

## 安装

1. 把本仓库放到 `ComfyUI/custom_nodes/ComfyUI-Banzhang-All`。
2. **完全重启 ComfyUI**（只刷新网页不生效）。改过 `js/` 里的文件再加 `Ctrl+F5`。
3. Python 依赖见 `requirements.txt`。

## 界面预览

**H3 导演台**：多段续写、成片监视、时间轴与参数集中在一处。

<a href="director-studio.jpg"><img src="director-studio.jpg" width="560" alt="H3 导演台"></a>

**H3 文案台 ＋ H3 媒体架**：分段文案编辑与参考素材管理。

<a href="desk-media-rack.png"><img src="desk-media-rack.png" width="560" alt="H3 文案台与媒体架"></a>

**MV 视频制作**：4 段续写配合音频波形，按节拍排片与逐段预览。

<a href="mv-studio.png"><img src="mv-studio.png" width="560" alt="MV 视频制作"></a>

## 外部组件与许可说明

- **模型网盘（夸克）**：作者已把本插件所需的全部模型汇总在一个网盘，直接下载即可：
  [https://pan.quark.cn/s/70186cdde3ab?pwd=Lqse](https://pan.quark.cn/s/70186cdde3ab?pwd=Lqse)（提取码已含在链接里）。
- **ComfyUI-H3-Motion-Context**（GPLv3）：导演台的潜空间续写算术、钉帧切片、栅格校对依赖它。仓库内 `_h3mc/` 已随包内置一份实现，遵循其自带 `LICENSE`；如需上游更新可自行替换。
- **MiniMax H3 模型权重**（MiniMax H3 Community License，含地域与营收门槛限制）、**NVIDIA VFX / DLSS / Topaz 专有引擎与二进制**、**字体**：不随本仓库分发，需按各自许可自行获取；相关节点未装引擎时不会生效。

## 许可

本仓库整体采用 **GPL-3.0-or-later**，全文见 `LICENSE`。

第三方组件的来源与各自许可见 `NOTICE.md`；各 vendor 目录内也保留了上游原始 `LICENSE` / `NOTICE`。

## 商业授权

本仓库按 GPL-3.0-or-later 提供，符合 GPL 的使用无需另行联系。

**用本插件做出来的内容可以随便赚钱**：短剧、广告、MV、接单、平台投稿变现 —— 生成的视频／图片／音频属于你的作品，不受 GPL 约束，**无需另行授权，也无需付费**。GPL 约束的是代码的分发，不是作品的使用。

需要单独商议的只有一种情况：把插件代码（或改动版）**打包进自己的闭源软件／产品对外分发或销售**，且不愿公开改动。这种可通过 GitHub Issues 或下方微信联系作者。

注意：模型权重有独立许可，MiniMax H3 Community License 含地域与营收门槛等限制，商用前请自行确认；`NOTICE.md` 所列第三方组件（尤其 `_h3mc/`，GPLv3）也不在可授权范围内，仍须遵守各自许可。

## 更新日志

每次更新了什么见 [CHANGELOG.md](CHANGELOG.md)。

## 联系与更新

- B 站主页：[班长captain](https://space.bilibili.com/15838129?spm_id_from=333.788.0.0)
- 微信：点开下方二维码放大后扫码

<a href="wechat-qr.png"><img src="wechat-qr.png" width="285" alt="微信二维码"></a>

## 问题反馈

请用 GitHub Issues，提交时附上 ComfyUI 版本与终端最后几行报错。
