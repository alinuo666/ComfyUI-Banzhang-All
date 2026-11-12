/* ============================================================
 * 媒体加载器 → H3 面板的「零拷贝引用」通道
 * ------------------------------------------------------------
 * 文件已经躺在 ComfyUI input 目录里时，接收方只要拿到它**相对 input 的路径**
 * 写进槽位就能定位，不必把字节下载下来再 POST /upload/image 重传一遍——
 * 重传必然在同目录里落第二个文件（同名被改名、或覆盖），这才是「明明
 * 在一个文件夹里还复制一份」的根因。
 *
 * 不在 input 目录里的文件（加载器可以指向任意目录）拿不到这个相对路径，
 * 继续走原来的字节投放。
 * ============================================================ */
export const BZ_MEDIA_MIME = "application/x-banzhang-media";

/* dragover 阶段浏览器保护数据，getData 恒为空串，只能看 types；
   drop 阶段才取得到值。两个函数因此分开。 */
export function hasRef(e) {
  return Array.from(e?.dataTransfer?.types || []).includes(BZ_MEDIA_MIME);
}

export function relFromEvent(e) {
  if (!hasRef(e)) return "";
  try {
    return JSON.parse(e.dataTransfer.getData(BZ_MEDIA_MIME))?.rel || "";
  } catch (_) {
    return "";
  }
}
