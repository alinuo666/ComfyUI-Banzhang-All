# -*- coding: utf-8 -*-
"""素材池小工具：看一眼素材清单 / 换一张图（全片生效，不用逐段改）。

用法（用 ComfyUI 自带的 python，在任意目录下执行）：

  看清单：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\bz_asset_pool.py list 未命名工程 16

  换图（把「陈九一」这张素材换成另一个文件）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\bz_asset_pool.py set 未命名工程 16 陈九一 cglide/陈九一_v2.png

说明：换图＝把引用该名字的段换绑到新文件（素材按内容哈希认身份，同名不同内容
互不干扰）；改之前会自动把 project.db 备份成 project.db.bak_asset_set。
同名素材有多份时，list 清单里的名字会带「#哈希8位」后缀，set 用带后缀的名字
指定换哪一份；不带后缀会列出候选让你挑。

  回滚结构（换回旧版代码**之前**跑，把素材池主键从哈希降回别名）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\bz_asset_pool.py downgrade 未命名工程 16
"""
import os
import sys
import shutil

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
for _p in (COMFY_ROOT, os.path.abspath(os.path.join(HERE, ".."))):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import csglide_store as S  # noqa: E402


def chain_dir(name):
    return os.path.join(COMFY_ROOT, "output", "h3_chain", name)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    cmd, name = sys.argv[1], sys.argv[2]
    d = chain_dir(name)
    if not S.has_db(d):
        print("找不到工程库：%s（工程名要用 output\\h3_chain 下的目录名）" % d)
        return 1

    if cmd == "list":
        pool = S.load_pool(d)
        print("素材池「%s」共 %d 项：" % (name, len(pool)))
        for k in sorted(pool.keys()):
            print("  %-14s %s" % (k, pool[k]["file"]))
        return 0

    if cmd == "set":
        if len(sys.argv) < 5:
            print("set 需要两个参数：素材名 文件路径")
            return 1
        alias, f = sys.argv[3], sys.argv[4]
        shutil.copyfile(os.path.join(d, "project.db"),
                        os.path.join(d, "project.db.bak_asset_set"))
        try:
            n = S.set_asset_file(d, alias, f)
        except ValueError as e:
            print("%s\n用带后缀的名字再试一次（后缀见 list 清单）。" % e)
            return 1
        if not n:
            print("池里没有「%s」，什么都没改。现有名字用 list 看一眼。" % alias)
            return 1
        print("已把「%s」换成 %s —— %d 段跟着一起变了。\n"
              "改前备份：project.db.bak_asset_set" % (alias, f, n))
        return 0

    if cmd == "downgrade":
        ok = S.downgrade_pool_to_v4(d)
        print("已降回 v4 结构（别名主键）。现在可以换回旧版代码并重启 ComfyUI。"
              if ok else "无需降级：这个库本来就不是哈希主键结构。")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
