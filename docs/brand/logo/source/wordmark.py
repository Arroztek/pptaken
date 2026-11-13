"""Convert the PPTaken wordmark (Bricolage Grotesque) to SVG paths.
Usage: python -I wordmark.py <font.woff2> <opsz> <out.json>
Outputs JSON with path data in font units scaled to cap-height = 100.
"""
import sys, io, json
sys.path.insert(0, __file__.rsplit('\\', 1)[0] + '\\pylib')
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

src, opsz, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
TRACK = -0.02  # em

def inst(wght):
    f = TTFont(src)
    f.flavor = None
    i = instancer.instantiateVariableFont(f, {"wght": wght, "opsz": opsz})
    buf = io.BytesIO(); i.save(buf)
    return i, buf.getvalue()

runs = [("PP", 800), ("Taken", 500)]
x = 0.0
paths = []
meta = {}
for text, w in runs:
    font, data = inst(w)
    upem = font['head'].unitsPerEm
    cap = font['OS/2'].sCapHeight
    meta = {"upem": upem, "cap": cap, "xh": font['OS/2'].sxHeight, "desc": font['hhea'].descent}
    face = hb.Face(data); hbf = hb.Font(face)
    buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
    hb.shape(hbf, buf, {"kern": True, "liga": True})
    gs = font.getGlyphSet(); order = font.getGlyphOrder()
    run = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        pen = SVGPathPen(gs)
        # flip y: font y up -> svg y down, baseline at y=cap (so cap top = 0)
        tp = TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, cap - pos.y_offset))
        gs[name].draw(tp)
        run.append({"g": name, "x": x, "adv": pos.x_advance, "d": pen.getCommands()})
        x += pos.x_advance + TRACK * upem
    paths.append({"text": text, "wght": w, "glyphs": run})
json.dump({"meta": meta, "width": x - TRACK * meta["upem"], "runs": paths}, open(out, "w"), indent=1)
print(meta, x)
