# -*- coding: utf-8 -*-
"""RIFE 插帧的网络结构（IFNet）+ 光流变形函数

来源：Practical-RIFE (hzwer/ECCV2022-RIFE)，MIT 协议，2026-10-09 并入班长全家桶。
这里只保留推理要用的部分，训练相关的分支全部删掉了。
"""
import torch
import torch.nn as nn
import torch.nn.functional as F

_GRID_CACHE = {}


def warp(tenInput, tenFlow):
    """按光流把图像掰弯（RIFE 的标准后向变形）。"""
    key = (str(tenFlow.device), str(tenFlow.dtype), tenFlow.shape[2], tenFlow.shape[3])
    grid = _GRID_CACHE.get(key)
    if grid is None:
        horizontal = torch.linspace(-1.0, 1.0, tenFlow.shape[3], device=tenFlow.device)
        horizontal = horizontal.view(1, 1, 1, -1).expand(-1, -1, tenFlow.shape[2], -1)
        vertical = torch.linspace(-1.0, 1.0, tenFlow.shape[2], device=tenFlow.device)
        vertical = vertical.view(1, 1, -1, 1).expand(-1, -1, -1, tenFlow.shape[3])
        grid = torch.cat([horizontal, vertical], 1).to(tenFlow.dtype)
        _GRID_CACHE[key] = grid

    tenFlow = torch.cat([
        tenFlow[:, 0:1] / ((tenInput.shape[3] - 1.0) / 2.0),
        tenFlow[:, 1:2] / ((tenInput.shape[2] - 1.0) / 2.0),
    ], 1)
    return F.grid_sample(input=tenInput, grid=(grid + tenFlow).permute(0, 2, 3, 1),
                         mode="bilinear", padding_mode="border", align_corners=True)


def conv(in_planes, out_planes, kernel_size=3, stride=1, padding=1, dilation=1):
    return nn.Sequential(
        nn.Conv2d(in_planes, out_planes, kernel_size, stride, padding, dilation, bias=True),
        nn.LeakyReLU(0.2, True),
    )


class ResConv(nn.Module):
    def __init__(self, c, dilation=1):
        super().__init__()
        self.conv = nn.Conv2d(c, c, 3, 1, dilation, dilation=dilation)
        self.beta = nn.Parameter(torch.ones((1, c, 1, 1)), requires_grad=True)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        return self.relu(self.conv(x) * self.beta + x)


class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        x = self.relu(self.cnn0(x))
        x = self.relu(self.cnn1(x))
        x = self.relu(self.cnn2(x))
        return self.cnn3(x)


class IFBlock(nn.Module):
    def __init__(self, in_planes, c=64):
        super().__init__()
        self.conv0 = nn.Sequential(conv(in_planes, c // 2, 3, 2, 1), conv(c // 2, c, 3, 2, 1))
        self.convblock = nn.Sequential(*[ResConv(c) for _ in range(8)])
        self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 13, 4, 2, 1), nn.PixelShuffle(2))

    def forward(self, x, flow=None, scale=1):
        x = F.interpolate(x, scale_factor=1.0 / scale, mode="bilinear", align_corners=False)
        if flow is not None:
            flow = F.interpolate(flow, scale_factor=1.0 / scale, mode="bilinear",
                                 align_corners=False) / scale
            x = torch.cat((x, flow), 1)
        feat = self.convblock(self.conv0(x))
        tmp = F.interpolate(self.lastconv(feat), scale_factor=scale, mode="bilinear",
                            align_corners=False)
        return tmp[:, :4] * scale, tmp[:, 4:5], tmp[:, 5:]


class IFNet(nn.Module):
    """RIFE HDv3 主干：5 级逐步细化光流，最后合成中间帧。"""

    def __init__(self):
        super().__init__()
        self.block0 = IFBlock(7 + 8, c=192)
        self.block1 = IFBlock(8 + 4 + 8 + 8, c=128)
        self.block2 = IFBlock(8 + 4 + 8 + 8, c=96)
        self.block3 = IFBlock(8 + 4 + 8 + 8, c=64)
        self.block4 = IFBlock(8 + 4 + 8 + 8, c=32)
        self.encode = Head()

    def forward(self, x, timestep=0.5, scale_list=(16, 8, 4, 2, 1)):
        channel = x.shape[1] // 2
        img0, img1 = x[:, :channel], x[:, channel:]
        if not torch.is_tensor(timestep):
            timestep = (x[:, :1].clone() * 0 + 1) * timestep
        else:
            timestep = timestep.repeat(1, 1, img0.shape[2], img0.shape[3])

        f0, f1 = self.encode(img0[:, :3]), self.encode(img1[:, :3])
        flow, mask, feat = None, None, None
        warped_img0, warped_img1 = img0, img1
        merged = []
        blocks = [self.block0, self.block1, self.block2, self.block3, self.block4]

        for i in range(5):
            if flow is None:
                flow, mask, feat = blocks[i](
                    torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1), None,
                    scale=scale_list[i])
            else:
                fd, m0, feat = blocks[i](
                    torch.cat((warped_img0[:, :3], warped_img1[:, :3], warp(f0, flow[:, :2]),
                               warp(f1, flow[:, 2:4]), timestep, mask, feat), 1),
                    flow, scale=scale_list[i])
                mask = m0
                flow = flow + fd
            warped_img0, warped_img1 = warp(img0, flow[:, :2]), warp(img1, flow[:, 2:4])
            merged.append((warped_img0, warped_img1))

        mask = torch.sigmoid(mask)
        merged[4] = warped_img0 * mask + warped_img1 * (1 - mask)
        return merged[-1]
