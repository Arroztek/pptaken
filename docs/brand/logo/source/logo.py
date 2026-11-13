"""Build the final PPTaken logo set. python -I logo.py <wordmark.json> <outdir>"""
import json, math, sys, os

WM, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
INK, CHALK, SPOTLIGHT, BACKSTAGE = "#16181D", "#F2EFE9", "#FFB224", "#0F1115"

# ---------- isotype geometry (64 grid) ----------
R = 12  # bowl outer radius (right side)
FRAME = (f"M13 4H{59-R}A{R} {R} 0 0 1 59 {4+R}V{36-R}A{R} {R} 0 0 1 {59-R} 36"
         "H21V54A6 6 0 0 1 9 54V8A4 4 0 0 1 13 4Z")
def rrect(x, y, w, h, r):
    return (f"M{x+r:g} {y:g}H{x+w-r:g}A{r:g} {r:g} 0 0 1 {x+w:g} {y+r:g}V{y+h-r:g}"
            f"A{r:g} {r:g} 0 0 1 {x+w-r:g} {y+h:g}H{x+r:g}A{r:g} {r:g} 0 0 1 {x:g} {y+h-r:g}"
            f"V{y+r:g}A{r:g} {r:g} 0 0 1 {x+r:g} {y:g}Z")
COUNTER = rrect(21, 11, 32, 18, 2.5)  # exact 16:9 slide

def stroke_outline(pts, w, steps=10):
    """Outline of an open polyline stroked with round caps and joins (as polygon path)."""
    h = w / 2
    def sub(a, b): return (a[0]-b[0], a[1]-b[1])
    def norm(v): l = math.hypot(*v); return (v[0]/l, v[1]/l)
    left, right = [], []
    segs = list(zip(pts, pts[1:]))
    def arc(c, a0, a1, n=steps):
        return [(c[0]+h*math.cos(a0+(a1-a0)*i/n), c[1]+h*math.sin(a0+(a1-a0)*i/n)) for i in range(n+1)]
    # this chevron has a single vertex; build explicitly
    p0, p1, p2 = pts
    d1, d2 = norm(sub(p1, p0)), norm(sub(p2, p1))
    a_n1 = math.atan2(d1[1], d1[0]) - math.pi/2   # left normal angle of seg1
    a_n2 = math.atan2(d2[1], d2[0]) - math.pi/2
    poly = []
    # outer side (left normals, y-down) seg1 then join arc then seg2
    poly += [(p0[0]+h*math.cos(a_n1), p0[1]+h*math.sin(a_n1))]
    da = a_n2 - a_n1
    while da > math.pi: da -= 2*math.pi
    while da < -math.pi: da += 2*math.pi
    poly += arc(p1, a_n1, a_n1+da)
    poly += [(p2[0]+h*math.cos(a_n2), p2[1]+h*math.sin(a_n2))]
    poly += arc(p2, a_n2, a_n2+math.pi)[1:]          # end cap
    # inner side: intersection of right offsets
    r1a = (p0[0]-h*math.cos(a_n1), p0[1]-h*math.sin(a_n1)); r2b = (p2[0]-h*math.cos(a_n2), p2[1]-h*math.sin(a_n2))
    # line r1a + t*d1 meets r2b - s*d2
    den = d1[0]*(-d2[1]) - d1[1]*(-d2[0])
    t = ((r2b[0]-r1a[0])*(-d2[1]) - (r2b[1]-r1a[1])*(-d2[0])) / den
    poly += [(r1a[0]+t*d1[0], r1a[1]+t*d1[1])]
    poly += arc(p0, a_n1+math.pi, a_n1+2*math.pi)  # start cap
    return "M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in poly) + "Z"

CHEV_PTS = [(34.75, 15), (40.25, 20), (34.75, 25)]
CHEV = stroke_outline(CHEV_PTS, 3.75)

def iso_paths(frame, mode):
    """mode: color | mono | stamp. Returns inner SVG markup in 64 grid."""
    if mode == "color":
        return (f'<path fill="{frame}" fill-rule="evenodd" d="{FRAME}{COUNTER}"/>'
                f'<path fill="{SPOTLIGHT}" d="{COUNTER}"/><path fill="{INK}" d="{CHEV}"/>')
    gap = 2 if mode == "mono" else 2.5
    inner = rrect(21+gap, 11+gap, 32-2*gap, 18-2*gap, max(0.5, 2.5-gap/2))
    return f'<path fill="{frame}" fill-rule="evenodd" d="{FRAME}{COUNTER}{inner}{CHEV}"/>'

# ---------- 16 / 32 px favicon geometry (pixel grid, no arrow) ----------
F16_FRAME = "M3 1H11.5A2.5 2.5 0 0 1 14 3.5V6.5A2.5 2.5 0 0 1 11.5 9H5V13.5A1.5 1.5 0 0 1 2 13.5V2A1 1 0 0 1 3 1Z"
F16_COUNTER = rrect(5, 3, 7, 4, 0.5)
F32_FRAME = "M6 2H23A6 6 0 0 1 29 8V11A6 6 0 0 1 23 17H10V27A3 3 0 0 1 4 27V4A2 2 0 0 1 6 2Z"
F32_COUNTER = rrect(10, 5, 16, 9, 1)

def svg(vb, body, title, extra=""):
    _, _, w, h = vb.split()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}" role="img" aria-label="{title}"{extra}>'
            f'<title>{title}</title>{body}</svg>\n')

def write(name, s):
    open(os.path.join(OUT, name), "w", encoding="utf-8").write(s)

# isotypes
write("pptaken-isotype.svg", svg("0 0 64 64", iso_paths(INK, "color"), "PPTaken"))
write("pptaken-isotype-on-dark.svg", svg("0 0 64 64", iso_paths(CHALK, "color"), "PPTaken"))
write("pptaken-isotype-mono-ink.svg", svg("0 0 64 64", iso_paths(INK, "mono"), "PPTaken"))
write("pptaken-isotype-mono-chalk.svg", svg("0 0 64 64", iso_paths(CHALK, "mono"), "PPTaken"))
write("pptaken-isotype-stamp.svg", svg("0 0 64 64", iso_paths("#000000", "stamp"), "PPTaken"))

# favicons
def fav(frame_d, counter_d, size, adaptive):
    if adaptive:
        style = (f'<style>.f{{fill:{INK}}}@media (prefers-color-scheme:dark){{.f{{fill:{CHALK}}}}}</style>')
        return svg(f"0 0 {size} {size}", f'{style}<path class="f" fill-rule="evenodd" d="{frame_d}{counter_d}"/><path fill="{SPOTLIGHT}" d="{counter_d}"/>', "PPTaken")
    return svg(f"0 0 {size} {size}", f'<path fill="{INK}" fill-rule="evenodd" d="{frame_d}{counter_d}"/><path fill="{SPOTLIGHT}" d="{counter_d}"/>', "PPTaken")
write("favicon.svg", fav(F16_FRAME, F16_COUNTER, 16, True))
write("favicon-16.svg", fav(F16_FRAME, F16_COUNTER, 16, False))
write("favicon-32.svg", fav(F32_FRAME, F32_COUNTER, 32, False))
write("favicon-32-on-dark.svg", fav(F32_FRAME, F32_COUNTER, 32, False).replace(INK, CHALK, 1))
write("favicon-16-on-dark.svg", fav(F16_FRAME, F16_COUNTER, 16, False).replace(INK, CHALK, 1))

# app icon (512): isotype on Backstage, generous padding. Not a "square of amber".
write("pptaken-app-icon.svg", svg("0 0 512 512",
      f'<rect width="512" height="512" rx="112" fill="{BACKSTAGE}"/><g transform="translate(86 96) scale(5)">{iso_paths(CHALK, "color")}</g>', "PPTaken"))

# ---------- wordmark + lockup ----------
wm = json.load(open(WM)); cap = wm["meta"]["cap"]
glyphs = [g for r in wm["runs"] for g in r["glyphs"]]
# Lockup: cap height = 28 units, wordmark vertically centred on the bowl+stem optical centre.
CAP = 30.0
s = CAP / cap
GAP = 14  # space between isotype and wordmark (~1.2 x stem width)
WM_X = 59 + GAP
WM_Y = 36 - CAP  # baseline sits on the bowl bottom; the stem descends like a descender
import re
wm_d = re.sub(r"-?\d+\.\d+", lambda m: str(round(float(m.group()))), "".join(g["d"] for g in glyphs))
wm_w = wm["width"] * s
def wm_group(fill):
    return f'<path fill="{fill}" transform="translate({WM_X} {WM_Y:.2f}) scale({s:.5f})" d="{wm_d}"/>'
LW = math.ceil(WM_X + wm_w + 4)
vb = f"4 0 {LW-4+1} 64"
write("pptaken-lockup.svg", svg(vb, iso_paths(INK, "color") + wm_group(INK), "PPTaken"))
write("pptaken-lockup-on-dark.svg", svg(vb, iso_paths(CHALK, "color") + wm_group(CHALK), "PPTaken"))
write("pptaken-lockup-mono-ink.svg", svg(vb, iso_paths(INK, "mono") + wm_group(INK), "PPTaken"))
write("pptaken-lockup-mono-chalk.svg", svg(vb, iso_paths(CHALK, "mono") + wm_group(CHALK), "PPTaken"))
write("pptaken-lockup-stamp.svg", svg(vb, iso_paths("#000000", "stamp") + wm_group("#000000"), "PPTaken"))
# wordmark alone
write("pptaken-wordmark.svg", svg(f"0 -2 {wm_w+2:.0f} {CAP+4:.0f}", f'<path fill="{INK}" transform="scale({s:.5f})" d="{wm_d}"/>', "PPTaken"))
write("pptaken-wordmark-on-dark.svg", svg(f"0 -2 {wm_w+2:.0f} {CAP+4:.0f}", f'<path fill="{CHALK}" transform="scale({s:.5f})" d="{wm_d}"/>', "PPTaken"))
print("lockup width", LW, "wm width", wm_w)

# ---------- embeddable markup (frame + wordmark in currentColor) ----------
iso_cc = iso_paths("currentColor", "color")
lock_cc = iso_cc + wm_group("currentColor")
fav16_cc = f'<path fill="currentColor" fill-rule="evenodd" d="{F16_FRAME}{F16_COUNTER}"/><path fill="{SPOTLIGHT}" d="{F16_COUNTER}"/>'
emb = {"isotype": {"viewBox": "0 0 64 64", "body": iso_cc},
       "isotypeSmall": {"viewBox": "0 0 16 16", "body": fav16_cc},
       "lockup": {"viewBox": vb, "body": lock_cc}}
if len(sys.argv) > 4:
    open(sys.argv[3], "w", encoding="utf-8").write(
        "// Generated from docs/brand/logo/source/logo.py. Do not edit by hand.\n"
        "// Frame and wordmark use currentColor (Ink on light, Chalk on dark); the slide is always Spotlight.\n"
        f"export const logo = {json.dumps(emb, indent=2)} as const;\n")
    open(sys.argv[4], "w", encoding="utf-8").write(
        "/* Generated by docs/brand/logo/source/logo.py. Preview only. */\nwindow.PPT_LOGO = " + json.dumps(emb) + ";\n")
