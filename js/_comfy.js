/**
 * ComfyUI 前端对象的统一转发口。
 *
 * bvl/ 下的模块一律从本文件取 app / api，不各自写相对路径：
 * ComfyUI 把 js/ 目录整体挂到 /extensions/<节点包名>/ 下，
 * 子目录里的文件要多退一级，写死容易错；这里只写一次，将来变动也只改这一处。
 */

export { app } from "../../scripts/app.js";
export { api } from "../../scripts/api.js";
