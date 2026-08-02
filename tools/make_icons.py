#!/usr/bin/env python3
"""アイコン PNG を生成する（標準ライブラリのみ / 依存なし）。

青の角丸スクエアに白い星。4倍スーパーサンプリングでアンチエイリアスする。
    python3 tools/make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
BG = (26, 115, 232)      # Google Blue 600
FG = (255, 255, 255)
SS = 4                   # supersampling factor


def rounded_rect_hit(x, y, size, radius):
    """角丸矩形の内側なら True。"""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2 or (
        radius <= x <= size - radius or radius <= y <= size - radius
    )


def star_polygon(cx, cy, outer, inner, points=5):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        ang = -math.pi / 2 + i * math.pi / points
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def point_in_polygon(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def render(size):
    big = size * SS
    radius = big * 0.22
    star = star_polygon(big / 2, big * 0.52, big * 0.33, big * 0.145)

    # スーパーサンプル面をブール2枚で持ち、あとで平均してアルファ/色を決める
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            a_sum = 0
            f_sum = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5
                    if not rounded_rect_hit(x, y, big, radius):
                        continue
                    a_sum += 1
                    if point_in_polygon(x, y, star):
                        f_sum += 1
            total = SS * SS
            alpha = a_sum / total
            if alpha == 0:
                row += bytes((0, 0, 0, 0))
                continue
            mix = f_sum / a_sum
            r = round(BG[0] * (1 - mix) + FG[0] * mix)
            g = round(BG[1] * (1 - mix) + FG[1] * mix)
            b = round(BG[2] * (1 - mix) + FG[2] * mix)
            row += bytes((r, g, b, round(alpha * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in SIZES:
        write_png(out / f"icon{size}.png", render(size), size)
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
