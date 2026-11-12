# 班长全家桶 · ComfyUI 自定义节点包

面向 MiniMax H3 长片创作的中文节点集合：多段续写、导演台、AI 制片中枢、钉帧漂移控制、显存管理、文本与字幕工具。

## 安装

1. 把本仓库放到 `ComfyUI/custom_nodes/ComfyUI-Banzhang-All`。
2. **完全重启 ComfyUI**（只刷新网页不生效）。改过 `js/` 里的文件再加 `Ctrl+F5`。
3. Python 依赖见 `requirements.txt`。

## 需要自行准备的外部依赖

本仓库不含以下内容，请按各自许可自行获取：

- **ComfyUI-H3-Motion-Context**（GPLv3）：导演台的潜空间续写算术、钉帧切片、栅格校对依赖它。仓库内 `_h3mc/` 为随包保留的一份实现，请同时遵守其自带的 `LICENSE`。
- **MiniMax H3 模型权重**：遵循 MiniMax H3 Community License，有地域与用途限制，不随本仓库分发。
- **NVIDIA VFX / DLSS / Topaz 相关引擎与二进制**：专有组件，不随本仓库分发。相关节点在未安装引擎时不会生效。
- **字体**：界面字体请用系统自带或自行取得授权。

## 许可

本仓库整体采用 **GPL-3.0-or-later**，全文见 `LICENSE`。
第三方组件的来源与各自许可见 `NOTICE.md`；各 vendor 目录内也保留了上游原始 `LICENSE` / `NOTICE`。

## 联系与更新

- B 站主页：[班长captain](https://space.bilibili.com/15838129?spm_id_from=333.788.0.0)
- 微信：扫码添加好友

![微信二维码](wechat-qr.png)

## 问题反馈

请用 GitHub Issues。提交时附上 ComfyUI 版本与终端最后几行报错。
