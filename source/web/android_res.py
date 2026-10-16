# Replaces Capacitor's default launcher icons and splash images with TimeVault's.
# Usage: python3 android_res.py <android res folder>
import glob, os, sys
from PIL import Image, ImageDraw

BRASS = (108, 116, 255, 255); DARK = (15, 15, 18, 255); WHITE = (255, 255, 255, 255)


def lock_symbol(d, c, R, S):
    w = int(S * 0.065)
    d.ellipse([c - R, c - R, c + R, c + R], outline=WHITE, width=max(1, w))
    k = S * 0.068
    d.ellipse([c - k, c - k * 1.6, c + k, c + k * 0.4], fill=WHITE)
    d.rounded_rectangle([c - k * 0.45, c - k * 0.4, c + k * 0.45, c + k * 1.9], radius=int(k * 0.4), fill=WHITE)


def legacy(size, round_=False):
    s = 4; S = size * s; im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    pad = int(S * 0.04)
    if round_: d.ellipse([pad, pad, S - pad, S - pad], fill=BRASS)
    else: d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=int(S * 0.22), fill=BRASS)
    lock_symbol(d, S / 2, S * 0.27, S)
    return im.resize((size, size), Image.LANCZOS)


def foreground(size):  # adaptive icon layer: 108dp canvas, keep the symbol inside the 66dp safe circle
    s = 4; S = size * s; im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    c = S / 2; scale = 0.66 / 1.0
    R = S * 0.29 * scale
    w = int(S * 0.065 * scale); d.ellipse([c - R, c - R, c + R, c + R], outline=WHITE, width=max(1, w))
    k = S * 0.068 * scale
    d.ellipse([c - k, c - k * 1.6, c + k, c + k * 0.4], fill=WHITE)
    d.rounded_rectangle([c - k * 0.45, c - k * 0.4, c + k * 0.45, c + k * 1.9], radius=int(k * 0.4), fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


def splash(w, h):
    im = Image.new('RGBA', (w, h), DARK); m = min(w, h); size = max(48, int(m * 0.28))
    ic = legacy(size); im.paste(ic, ((w - size) // 2, (h - size) // 2), ic)
    return im


def main(res):
    assert os.path.isdir(res), res
    dens = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    n = 0
    for name, px in dens.items():
        folder = os.path.join(res, 'mipmap-' + name); os.makedirs(folder, exist_ok=True)
        legacy(px).save(os.path.join(folder, 'ic_launcher.png'))
        legacy(px, True).save(os.path.join(folder, 'ic_launcher_round.png'))
        foreground(px * 108 // 48).save(os.path.join(folder, 'ic_launcher_foreground.png')); n += 3
    vals = os.path.join(res, 'values'); os.makedirs(vals, exist_ok=True)
    open(os.path.join(vals, 'ic_launcher_background.xml'), 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#6C74FF</color>\n</resources>\n')
    for f in glob.glob(os.path.join(res, 'drawable*', 'splash.png')):
        w, h = Image.open(f).size; splash(w, h).save(f); n += 1
    print('android resources written:', n, 'images')


if __name__ == '__main__':
    main(sys.argv[1])
