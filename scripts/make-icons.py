"""Génère l'icône de Feuillet (PC, Android, web) : feuille au coin replié + trait de stylo.
Utilisation : python3 scripts/make-icons.py (nécessite Pillow)."""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

S = 1024


def icon(size=S, background=True, inset=0.0):
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if background:
        # Fond : carré arrondi, dégradé bleu.
        grad = Image.new('RGBA', (S, S))
        g = ImageDraw.Draw(grad)
        for y in range(S):
            t = y / S
            g.line([(0, y), (S, y)], fill=(int(64 + 20 * t), int(120 - 40 * t), int(255 - 50 * t), 255))
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
        im.paste(grad, (0, 0), mask)
    k = 1 - inset

    def P(x, y):
        return (S / 2 + (x - S / 2) * k, S / 2 + (y - S / 2) * k)

    # Ombre portée de la feuille
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([P(290, 210), P(640, 210), P(760, 330), P(760, 830), P(290, 830)], fill=(0, 0, 40, 90))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)), (0, 14))
    d = ImageDraw.Draw(im)
    # Feuille et coin replié
    d.polygon([P(280, 190), P(630, 190), P(750, 310), P(750, 820), P(280, 820)], fill=(255, 255, 255, 255))
    d.polygon([P(630, 190), P(630, 310), P(750, 310)], fill=(205, 218, 245, 255))
    # Lignes de texte
    for i, w in enumerate([330, 380, 300, 360]):
        y = 400 + i * 70
        d.rounded_rectangle([P(340, y), P(340 + w, y + 22)], radius=11 * k, fill=(196, 206, 228, 255))
    # Trait de stylo (vague)
    pts = [P(330 + t * 3.6, 720 + 38 * math.sin(t / 14)) for t in range(0, 101)]
    d.line(pts, fill=(255, 140, 40, 255), width=int(34 * k), joint='curve')
    return im.resize((size, size), Image.LANCZOS)


os.makedirs('build', exist_ok=True)
icon().save('build/icon.png')
icon().save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
os.makedirs('src/renderer/public', exist_ok=True)
icon(192).save('src/renderer/public/icon-192.png')
icon(512).save('src/renderer/public/icon-512.png')
icon(64).save('src/renderer/public/favicon.png')

# Android : icônes classiques, rondes et adaptatives (premier plan avec marge de sécurité)
res = 'android/app/src/main/res'
for name, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    folder = f'{res}/mipmap-{name}'
    if not os.path.isdir(folder):
        continue
    icon(px).save(f'{folder}/ic_launcher.png')
    round_mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(round_mask).ellipse([0, 0, px - 1, px - 1], fill=255)
    r = icon(px)
    r.putalpha(round_mask)
    r.save(f'{folder}/ic_launcher_round.png')
    icon(px * 108 // 48, background=False, inset=0.32).save(f'{folder}/ic_launcher_foreground.png')
print('icônes générées')
