"""Cut the icons out of tools/logo/mark.png. Run via tools/make-icons.sh."""
import base64, io, pathlib, re
from PIL import Image

REPO = pathlib.Path(__file__).resolve().parents[2]
src = Image.open(REPO / "tools/logo/mark.png").convert("L")

# White -> transparent, ink -> opaque. The scan is near-white (254) rather than pure white, so
# the ramp starts a little below that; everything darker keeps its own weight as anti-aliasing.
alpha = src.point(lambda v: 255 if v < 160 else (0 if v > 246 else int((246 - v) * 255 / 86)))
mark = Image.merge("RGBA", (Image.new("L", src.size, 0),) * 3 + (alpha,))
mark = mark.crop(alpha.getbbox())

def square(img, size, pad):
    """Fit on a transparent square with `pad` px of breathing room at that size."""
    box = size - 2 * pad
    w, h = img.size
    s = min(box / w, box / h)
    fit = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(fit, ((size - fit.width) // 2, (size - fit.height) // 2))
    return out

for size, pad in ((16, 0), (48, 2), (128, 6)):
    square(mark, size, pad).save(REPO / f"extension/icon{size}.png")

# The bar mark: 40px so it stays sharp on a 2x screen at its 15px box.
buf = io.BytesIO()
square(mark, 40, 0).save(buf, format="PNG", optimize=True)
uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
content = REPO / "extension/content.js"
text = content.read_text()
text, n = re.subn(r'(--mark-src: url\(")[^"]*("\))', lambda m: m.group(1) + uri + m.group(2), text)
assert n == 1, f"--mark-src not found in content.js (matched {n})"
content.write_text(text)
