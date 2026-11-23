"""Depth preview colormaps; the turbo table is byte-identical to the upstream CLI's."""

from __future__ import annotations

import base64

import numpy as np
import torch

_NAMES = ("turbo", "viridis", "inferno", "magma", "plasma")
_LUTS = np.frombuffer(
    base64.b64decode(
        "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vTl3vjl2wDp1wjp1wzt0xTx0xjxzyD1yyj5yyz5xzT9wzkBw0EFv0UJu00Jt1ENt1kRs10Vr2UZq2kdp3Ehp3Ulo3kpn4Etm4Uxm4k1l5E5k5VBj5lFi51Ji6FRh6lVg61Zg7Fhf7Vlf7lte7l1d715d8GBd8WFc8mNc82Vc82db9Ghb9Wpb9Wxb9m5b9nBb93Fb93Nc+HVc+Hdc+Xlc+Xtd+X1d+n9e+oBe+oJf+4Rg+4Zg+4hh+4pi/Ixj/I5j/JBk/JJl/JNm/ZVn/Zdo/Zlp/Ztq/Z1r/Z9s/aFu/aJv/aRw/qZx/qhz/qp0/qx1/q52/q94/rF5/rN7/rV8/rd9/rl//ruA/ryC/r6D/sCF/sKG/sSI/saJ/seL/smN/suO/c2Q/c+S/dGT/dKV/dSX/daY/dia/dqc/dyd/d2f/d+h/eGj/OOl/OWm/Oao/Oiq/Oqs/Oyu/O6w/PCx/PGz/PO1/PW3+/e5+/m7+/q9+/y/DAeGEAeHEwaJFQaKGAaLGwaMHQaNHwWOIQWPIwWQJQWRJwWSKQWTKwWULQSULwSVMQSWMwSXNASYNgSYOASZOgSaOwOaPQObPwOcQAOcQgOdRAOeRQOeRwKfSQKfSgKgTAKhTgKhTwKiUQGiUgGjVAGjVgGjVwGkWQGkWgClXAClXgClXwCmYQCmYgCmZACnZQCnZwCnaACnagCnbACobQCobwCocACocgCocwCodQCodgGoeAGoeQGoewKofAKnfgOnfwOngQSnggSnhAWmhQamhgemiAeliQiliwmkjAqkjgykjw2jkA6jkg+ikxChlRGhlhKglxOgmRSfmhWemxeenRidnhmcnxqboBubohyaox2ZpB6YpR+XpyGXqCKWqSOVqiSUrCWTrSaSrieRryiQsCqPsSuPsiyOtC2NtS6Mti+LtzCKuDKJuTOIujSHuzWGvDaFvTeEvjiDvzmCwDuBwTyAwj2Awz5/xD9+xUB9xkF8x0J7yER6yUV5ykZ4y0d3zEh2zUl1zkp1z0t00E1z0U5y0U9x0lBw01Fv1FJu1VNt1lVt11Zs11dr2Fhq2Vlp2lpo21tn3F1m3F5m3V9l3mBk32Fj32Ji4GRh4WVg4mZg42df42he5Gpd5Wtc5Wxb5m1a525a6HBZ6HFY6XJX6nNW6nRV63ZU7HdU7HhT7XlS7XtR7nxQ731P735O8IBN8IFN8YJM8oRL8oVK84ZJ84dI9IlH9IpH9YtG9Y1F9o5E9o9D9pFC95JB95NB+JVA+JY/+Jg++Zk9+Zo8+pw7+p06+p86+qA5+6I4+6M3+6Q2/KY1/Kc1/Kk0/Koz/Kwy/K0x/a8x/bAw/bIv/bMu/bUt/bYt/bgs/bkr/bsr/bwq/b4p/cAp/cEo/cMo/cQn/cYm/Mcm/Mkm/Msl/Mwl/M4l+9Ak+9Ek+9Mk+tUk+tYk+tgk+dkk+dsk+N0k+N8k9+Ak9+Il9uQl9uUl9ecm9ekm9Oom8+wm8+4m8vAm8vEm8fMm8PUl8PYj7/gh"
    ),
    dtype=np.uint8,
).reshape(len(_NAMES), 256, 3)

COLORMAPS = (*_NAMES, "gray")

#: Room above the nearest point of the first frame that fixes the scale, as in the upstream CLI.
HEADROOM = 0.2


def inverse_metric(depth: torch.Tensor) -> torch.Tensor:
    """``(T, H, W)`` metric depth -> ``1 / depth`` in 1/m, zero at sky and invalid pixels."""
    valid = torch.isfinite(depth) & (depth > 0)
    out = torch.zeros_like(depth)
    out[valid] = 1.0 / depth[valid]
    return out


def color_scale(inverse_metric_depth: torch.Tensor) -> float:
    """Top of the color scale, anchored on the first frame of the batch."""
    high = float(inverse_metric_depth[0].max())
    return high * (1.0 + HEADROOM) if high > 0 else 1.0


def colorize(inverse_metric_depth: torch.Tensor, colormap: str, scale: float) -> torch.Tensor:
    """``(T, H, W)`` inverse metric depth -> ``(T, H, W, 3)`` float RGB in 0..1."""
    if colormap == "gray":
        gray = (inverse_metric_depth / scale).clamp(0, 1)
        return gray.unsqueeze(-1).repeat(1, 1, 1, 3)
    index = (inverse_metric_depth * (256.0 / scale)).clamp(0, 255).to(torch.long)
    lut = torch.from_numpy(_LUTS[_NAMES.index(colormap)].copy()).to(index.device, torch.float32)
    return lut[index] / 255.0