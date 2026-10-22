#!/usr/bin/env python3
"""Generate the addon logo and banner with the Python standard library."""

import struct
import zlib
from pathlib import Path

YELLOW = (255, 219, 77, 255)
DARK = (23, 19, 10, 255)
INK = (25, 25, 32, 255)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(path: Path, width: int, height: int, pixels: bytearray) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride : (y + 1) * stride])
    payload = b"\x89PNG\r\n\x1a\n"
    payload += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    payload += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    payload += chunk(b"IEND", b"")
    path.write_bytes(payload)


def blend(pixels: bytearray, width: int, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if x < 0 or y < 0:
        return
    index = (y * width + x) * 4
    if index + 3 >= len(pixels):
        return
    sr, sg, sb, sa = color
    if sa >= 255:
        pixels[index : index + 4] = bytes((sr, sg, sb, 255))
        return
    dr, dg, db, da = pixels[index : index + 4]
    alpha = sa / 255.0
    out_a = int(sa + da * (1 - alpha))
    if out_a <= 0:
        return
    pixels[index] = int(sr * alpha + dr * (1 - alpha))
    pixels[index + 1] = int(sg * alpha + dg * (1 - alpha))
    pixels[index + 2] = int(sb * alpha + db * (1 - alpha))
    pixels[index + 3] = out_a


def rounded_rect(pixels: bytearray, width: int, height: int, x0: float, y0: float, x1: float, y1: float, radius: float, color: tuple[int, int, int, int]) -> None:
    for y in range(max(0, int(y0)), min(height, int(y1) + 1)):
        for x in range(max(0, int(x0)), min(width, int(x1) + 1)):
            cx = min(max(x + 0.5, x0 + radius), x1 - radius)
            cy = min(max(y + 0.5, y0 + radius), y1 - radius)
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius:
                blend(pixels, width, x, y, color)


def polygon(pixels: bytearray, width: int, height: int, points: list[tuple[float, float]], color: tuple[int, int, int, int]) -> None:
    min_x = max(0, int(min(p[0] for p in points)))
    max_x = min(width - 1, int(max(p[0] for p in points)))
    min_y = max(0, int(min(p[1] for p in points)))
    max_y = min(height - 1, int(max(p[1] for p in points)))
    for y in range(min_y, max_y + 1):
        py = y + 0.5
        for x in range(min_x, max_x + 1):
            px = x + 0.5
            inside = False
            j = len(points) - 1
            for i in range(len(points)):
                xi, yi = points[i]
                xj, yj = points[j]
                if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                    inside = not inside
                j = i
            if inside:
                blend(pixels, width, x, y, color)


def shield(pixels: bytearray, width: int, height: int, cx: float, top: float, scale: float, color: tuple[int, int, int, int]) -> None:
    half = 104 * scale
    points = [
        (cx - half, top),
        (cx + half, top),
        (cx + half, top + 158 * scale),
        (cx, top + 268 * scale),
        (cx - half, top + 158 * scale),
    ]
    polygon(pixels, width, height, points, color)
    heights = [36, 66, 96, 150, 96, 66, 36]
    bar_w = 12 * scale
    gap = 8 * scale
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = cx - total / 2
    center_y = top + 150 * scale
    for value in heights:
        h = value * scale
        rounded_rect(pixels, width, height, x, center_y - h / 2, x + bar_w, center_y + h / 2, bar_w / 2, DARK)
        x += bar_w + gap


def downsample(source: bytearray, width: int, height: int, factor: int) -> tuple[int, int, bytearray]:
    out_w, out_h = width // factor, height // factor
    out = bytearray(out_w * out_h * 4)
    area = factor * factor
    for y in range(out_h):
        for x in range(out_w):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    i = ((y * factor + dy) * width + (x * factor + dx)) * 4
                    r += source[i]
                    g += source[i + 1]
                    b += source[i + 2]
                    a += source[i + 3]
            j = (y * out_w + x) * 4
            out[j] = r // area
            out[j + 1] = g // area
            out[j + 2] = b // area
            out[j + 3] = a // area
    return out_w, out_h, out


def make_logo(path: Path) -> None:
    factor = 2
    width = height = 512 * factor
    pixels = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            t = y / height
            color = (int(28 - 8 * t), int(28 - 8 * t), int(35 - 8 * t), 255)
            blend(pixels, width, x, y, color)
    rounded_rect(pixels, width, height, 26 * factor, 26 * factor, 486 * factor, 486 * factor, 108 * factor, INK)
    for radius in range(230 * factor, 90 * factor, -4 * factor):
        alpha = int(3 + 10 * (1 - (radius - 90 * factor) / (140 * factor)))
        rounded_rect(pixels, width, height, 256 * factor - radius, 256 * factor - radius, 256 * factor + radius, 256 * factor + radius, radius, (255, 219, 77, max(0, alpha)))
    shield(pixels, width, height, 256 * factor, 134 * factor, factor, YELLOW)
    out_w, out_h, out = downsample(pixels, width, height, factor)
    png(path, out_w, out_h, out)


def make_banner(path: Path) -> None:
    width, height = 1600, 640
    pixels = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            t = x / width
            wave = (y / height - 0.5) * 0.18
            r = int(20 + 12 * t + 8 * max(0, wave))
            g = int(20 + 12 * t + 8 * max(0, wave))
            b = int(26 + 14 * t + 10 * max(0, wave))
            blend(pixels, width, x, y, (r, g, b, 255))
    for i in range(8):
        alpha = 5 + i * 2
        rounded_rect(pixels, width, height, 60 - i * 18, 600 - i * 14, 1560 + i * 18, 640 + i * 14, 30, (255, 219, 77, alpha))
    shield(pixels, width, height, 315, 158, 1.25, YELLOW)
    bars = [42, 96, 160, 240, 310, 240, 160, 96, 42, 70, 120, 190, 260, 190, 120, 70, 48, 110, 180, 250, 180, 110, 48]
    x = 660
    for index, value in enumerate(bars):
        h = value * 1.05
        color = (255, 219, 77, 255) if index % 3 else (255, 255, 255, 70)
        rounded_rect(pixels, width, height, x, 320 - h / 2, x + 14, 320 + h / 2, 7, color)
        x += 34
    rounded_rect(pixels, width, height, 110, 560, 1470, 563, 2, (255, 219, 77, 90))
    png(path, width, height, pixels)


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[1] / "addon" / "Assets"
    target.mkdir(parents=True, exist_ok=True)
    make_logo(target / "logo.png")
    make_banner(target / "banner.png")
    print(f"Wrote {target / 'logo.png'}")
    print(f"Wrote {target / 'banner.png'}")
