"""
Render a slide deck generation JSON into a .pptx file using python-pptx.

Usage:
    python render_pptx.py <input.json> <output.pptx> [template.pptx]

Input JSON shape (the generation's outline object):
    { "slides": [ { "layout": "title|bullets|...", "content": { ... } }, ... ], "theme": { ... } }

One design system for every layout: wide margins, a short accent bar over the title, one text colour and one
accent, white space instead of boxes and stripes. A slide with a picture gets a full-height panel on the right
and its text moves to the left column. Points can carry an icon (scripts/icons, white on an accent circle, so
one set serves every theme). Everything stays editable in PowerPoint: text boxes, shapes, real tables.
The editor's preview (td-prod-house-client src/pages/Review.jsx, components/figures/pictureLayout.js) mirrors
these measures: 1 inch here is 72 px there, and a point is a pixel.
"""

import json
import struct
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn

# ── Design tokens (a theme from templates/themes.json replaces the colours and fonts) ──
NAVY       = RGBColor(0x0F, 0x2B, 0x48)   # primary: titles, dark slides
NAVY_MID   = RGBColor(0x16, 0x3A, 0x60)
NAVY_LIGHT = RGBColor(0x1E, 0x4A, 0x7A)
COBALT     = RGBColor(0x25, 0x63, 0xEB)   # accent: one per slide, sparingly
COBALT_LT  = RGBColor(0x60, 0xA5, 0xFA)
SLATE      = RGBColor(0x47, 0x55, 0x69)   # body text
SLATE_LT   = RGBColor(0x94, 0xA3, 0xB8)   # quiet text: captions, slide numbers
BORDER     = RGBColor(0xE2, 0xE8, 0xF0)
CANVAS     = RGBColor(0xF0, 0xF4, 0xF8)   # panels and cards
WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
GREEN      = RGBColor(0x10, 0xB9, 0x81)
AMBER      = RGBColor(0xF5, 0x9E, 0x0B)

FONT_HEADING = 'Segoe UI'
FONT_BODY    = 'Segoe UI'

SLIDE_WIDTH  = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)

# ── Grid (inches) ──
M = 0.75                 # side margins
ACCENT_Y = 0.62          # the short accent bar over the title
TITLE_Y = 0.78
TITLE_H = 1.05
BODY_TOP = 2.05
BODY_BOTTOM = 6.75
PANEL_X = 7.55           # where the picture panel starts when a slide has one
PANEL_PAD = 0.45
CAPTION_H = 0.55

ICONS = Path(__file__).parent / 'icons'


def hex_color(value):
    value = value.lstrip('#')
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def blend(color, other, t):
    """color moved t of the way towards other (t=0.85 towards white: a light tint)."""
    return RGBColor(*(round(a + (b - a) * t) for a, b in zip(color, other)))


def apply_theme(theme):
    """Swap the design tokens for a template from templates/themes.json. The layout renderers read these
    module globals at call time, so every slide picks up the template."""
    global NAVY, NAVY_MID, NAVY_LIGHT, COBALT, COBALT_LT, SLATE, SLATE_LT, BORDER, CANVAS, WHITE, GREEN, AMBER
    global FONT_HEADING, FONT_BODY
    if not theme:
        return
    c = theme['colors']
    NAVY, NAVY_MID, NAVY_LIGHT = hex_color(c['primary']), hex_color(c['primary_mid']), hex_color(c['primary_light'])
    COBALT, COBALT_LT = hex_color(c['accent']), hex_color(c['accent_light'])
    SLATE, SLATE_LT = hex_color(c['text']), hex_color(c['text_light'])
    BORDER, CANVAS, WHITE = hex_color(c['border']), hex_color(c['canvas']), hex_color(c['surface'])
    GREEN, AMBER = hex_color(c['positive']), hex_color(c['warning'])
    FONT_HEADING = theme['fonts']['heading']
    FONT_BODY = theme['fonts']['body']


# ── Primitives ──

def set_slide_bg(slide, color):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def fitted_size(text, width, height, size, min_ratio=0.6):
    """Largest font size (down to min_ratio of `size`) at which `text` is estimated to fit the box.
    A safety net: the writer already keeps text within each layout's limits."""
    if not text:
        return size
    w_pt = int(width) / 12700 - 14.4   # box width minus default side insets (0.1in each)
    h_pt = int(height) / 12700 - 7.2   # box height minus top/bottom insets
    s = size
    while s > size * min_ratio:
        per_line = max(1, int(w_pt / (s * 0.52)))   # average glyph ~0.52em wide
        lines = sum(max(1, -(-len(par) // per_line)) for par in str(text).split('\n'))
        if lines * s * 1.2 <= h_pt:
            break
        s -= 1
    return s


def add_textbox(slide, left, top, width, height, text, font_size=18, bold=False, color=None,
                alignment=PP_ALIGN.LEFT, font_name=None, italic=False, anchor=None, spacing=1.12):
    color = color or NAVY  # resolved at call time so the theme applies
    font_size = fitted_size(text, width, height, font_size)
    box = slide.shapes.add_textbox(int(left), int(top), int(width), int(height))
    tf = box.text_frame
    tf.word_wrap = True
    if anchor:
        body_pr = tf._txBody.find(qn('a:bodyPr'))
        if body_pr is not None:
            body_pr.set('anchor', anchor)
    p = tf.paragraphs[0]
    p.text = text or ''
    p.alignment = alignment
    p.line_spacing = spacing
    f = p.font
    f.size, f.bold, f.italic, f.name = Pt(font_size), bold, italic, font_name or FONT_BODY
    f.color.rgb = color
    return box


def _no_line(shape):
    """No outline, and none of the default shape style (its effects add a drop shadow): flat shapes."""
    shape.line.fill.background()
    style = shape._element.find(qn('p:style'))
    if style is not None:
        shape._element.remove(style)
    return shape


def add_rect(slide, left, top, width, height, fill_color):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(left), int(top), int(width), int(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    return _no_line(shape)


def add_rounded_rect(slide, left, top, width, height, fill_color, radius=0.08):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, int(left), int(top), int(width), int(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    # radius in inches, whatever the box size
    shape.adjustments[0] = min(0.5, Inches(radius) / max(1, min(int(width), int(height))))
    return _no_line(shape)


def add_oval(slide, left, top, width, height, fill_color, transparency=0):
    shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, int(left), int(top), int(width), int(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if transparency > 0:
        srgb = shape._element.find(qn('p:spPr')).find(qn('a:solidFill')).find(qn('a:srgbClr'))
        alpha = srgb.makeelement(qn('a:alpha'), {})
        alpha.set('val', str(int((1 - transparency) * 100000)))
        srgb.append(alpha)
    return _no_line(shape)


def add_line(slide, x1, y1, x2, y2, color, width_pt=1.5):
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, int(x1), int(y1), int(x2), int(y2))
    line.line.color.rgb = color
    line.line.width = Pt(width_pt)
    return line


def add_icon(slide, name, left, top, size, fill=None):
    """An icon from scripts/icons on a filled circle; without an image for `name`, just the circle's number or
    nothing (callers pass a fallback through `name` only when it is a real icon)."""
    add_oval(slide, left, top, size, size, fill or COBALT)
    path = ICONS / f'{name}.png' if name else None
    if path and path.exists():
        inset = int(size) * 0.24
        slide.shapes.add_picture(str(path), int(left + inset), int(top + inset), int(size - 2 * inset), int(size - 2 * inset))
        return True
    return False


def add_marker(slide, icon, number, left, top, size):
    """A point's marker: its icon on an accent circle, else its number in the accent colour."""
    if icon and (ICONS / f'{icon}.png').exists():
        add_icon(slide, icon, left, top, size)
    else:
        add_textbox(slide, left - Inches(0.05), top - Inches(0.02), Inches(0.9), size, f'{number:02d}',
                    font_size=18, bold=True, color=COBALT, font_name=FONT_HEADING, anchor='ctr')


# ── Pictures ──

def png_size(path):
    """(width, height) in pixels, read from the PNG header."""
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Not a PNG: {path}')
    return struct.unpack('>II', head[16:24])


def _cropped(pic, crop):
    if any(crop):
        pic.crop_left, pic.crop_top, pic.crop_right, pic.crop_bottom = crop


def add_picture_fit(slide, path, left, top, max_w, max_h, crop=(0, 0, 0, 0)):
    """Place an image as large as fits in the box, keeping its aspect ratio, centred. crop (l, t, r, b
    fractions) uses PowerPoint's own cropping, so it stays adjustable in PowerPoint."""
    l, t, r, b = crop
    w_px, h_px = png_size(path)
    vis_w, vis_h = w_px * (1 - l - r), h_px * (1 - t - b)
    fit = min(int(max_w) / vis_w, int(max_h) / vis_h)
    w, h = int(vis_w * fit), int(vis_h * fit)
    _cropped(slide.shapes.add_picture(path, int(left) + (int(max_w) - w) // 2, int(top) + (int(max_h) - h) // 2, w, h), crop)


def add_picture_at(slide, path, x, y, w, crop=(0, 0, 0, 0)):
    """Place an image where the user put it in the editor: x, y, w as fractions of the slide."""
    l, t, r, b = crop
    w_px, h_px = png_size(path)
    width = int(SLIDE_WIDTH * w)
    height = int(width * (h_px * (1 - t - b)) / (w_px * (1 - l - r)))
    _cropped(slide.shapes.add_picture(path, int(SLIDE_WIDTH * x), int(SLIDE_HEIGHT * y), width, height), crop)


def image_settings(a):
    """The user's picture settings from the editor, clamped so a bad save can never hide the picture.
    Slides: x, y, w as fractions of the slide (None = fit the default area). Documents: w as a fraction of the
    text column, and align. Both: crop fractions (l, t, r, b) per edge."""
    a = a or {}

    def num(key, lo, hi):
        try:
            return min(hi, max(lo, float(a[key])))
        except (KeyError, TypeError, ValueError):
            return None

    crop = a.get('crop') or {}

    def edge(k):
        try:
            return min(0.95, max(0.0, float(crop.get(k, 0))))
        except (TypeError, ValueError):
            return 0.0
    l, t, r, b = edge('l'), edge('t'), edge('r'), edge('b')
    if l + r > 0.95:
        l = r = 0.0
    if t + b > 0.95:
        t = b = 0.0
    return {
        'x': num('x', -1.0, 1.0), 'y': num('y', -1.0, 1.0), 'w': num('w', 0.02, 1.5),
        'align': a.get('align') if a.get('align') in ('left', 'center', 'right') else 'center',
        'crop': (l, t, r, b),
    }


# Where a picture goes before the user moves it (fractions of the slide: x, y, w, h). The editor uses the same
# (components/figures/pictureLayout.js). A Figure slide: the band under the title. Any other slide: the panel on
# the right, leaving room for the caption under the picture.
FIGURE_BOX = (M / 13.333, (BODY_TOP - 0.05) / 7.5, (13.333 - 2 * M) / 13.333, (7.5 - BODY_TOP - 0.05 - CAPTION_H - 0.35) / 7.5)
SIDE_BOX = ((PANEL_X + PANEL_PAD) / 13.333, PANEL_PAD / 7.5, (13.333 - PANEL_X - 2 * PANEL_PAD) / 13.333,
            (7.5 - 2 * PANEL_PAD - CAPTION_H) / 7.5)
CAPTION_PT = 11
# Layouts that give their pictures the side panel; the others are visual already, or (figure) fill the slide.
PANEL_LAYOUTS = {'bullets', 'checklist', 'stat_focus', 'big_idea', 'quote_highlight', 'two_column', 'key_stats', 'icon_grid'}


def has_panel(content, layout):
    return layout in PANEL_LAYOUTS and bool(content.get('pictures'))


def draw_panel(slide):
    add_rect(slide, Inches(PANEL_X), 0, SLIDE_WIDTH - Inches(PANEL_X), SLIDE_HEIGHT, CANVAS)


def render_pictures(slide, content, layout):
    """Pictures placed on the slide, each with its caption under it, where the user put them in the editor."""
    for n, pic in enumerate(content.get('pictures') or []):
        img = image_settings(pic)
        path = pic.get('path')
        exists = bool(path) and Path(path).exists()
        l, t, r, b = img['crop']
        if exists:
            w_px, h_px = png_size(path)
            aspect = (h_px * (1 - t - b)) / (w_px * (1 - l - r))
        else:
            aspect = 0.6
        if None not in (img['x'], img['y'], img['w']):
            left, top, width = int(SLIDE_WIDTH * img['x']), int(SLIDE_HEIGHT * img['y']), int(SLIDE_WIDTH * img['w'])
            height = int(width * aspect)
        else:
            bx, by, bw, bh = FIGURE_BOX if layout == 'figure' and n == 0 else SIDE_BOX
            box_w, box_h = SLIDE_WIDTH * bw, SLIDE_HEIGHT * bh
            width = int(min(box_w, box_h / aspect))
            height = int(width * aspect)
            left = int(SLIDE_WIDTH * bx + (box_w - width) / 2)
            top = int(SLIDE_HEIGHT * by + (box_h - height) / 2)
        if exists:
            _cropped(slide.shapes.add_picture(path, left, top, width, height), img['crop'])
        else:
            add_textbox(slide, left, top, width, height, 'Image removed' if pic.get('image_id') else 'Figure removed',
                        font_size=16, color=SLATE_LT, alignment=PP_ALIGN.CENTER, anchor='ctr')
        caption = (pic.get('caption') or '').strip()
        if caption:
            cap_w = max(width, Inches(3.2))
            add_textbox(slide, left + (width - cap_w) // 2, top + height + Inches(0.08), cap_w, Inches(CAPTION_H), caption,
                        font_size=CAPTION_PT, color=SLATE, alignment=PP_ALIGN.CENTER)


# ── Shared slide parts ──

def text_width(content, layout):
    """The width text may use (inches): the whole slide, or the left column beside a picture panel."""
    return (PANEL_X - M - 0.45) if has_panel(content, layout) else (13.333 - 2 * M)


def title_block(slide, title, width):
    """The short accent bar and the title over every content slide."""
    add_rect(slide, Inches(M), Inches(ACCENT_Y), Inches(0.55), Inches(0.06), COBALT)
    add_textbox(slide, Inches(M) - Inches(0.05), Inches(TITLE_Y), Inches(width), Inches(TITLE_H), title or '',
                font_size=30, bold=True, color=NAVY, font_name=FONT_HEADING, spacing=1.0)


def footer(slide, slide_idx, total, dark=False):
    if not total:
        return
    add_textbox(slide, SLIDE_WIDTH - Inches(1.45), SLIDE_HEIGHT - Inches(0.55), Inches(0.9), Inches(0.35),
                f'{slide_idx:02d}', font_size=10, color=(SLATE_LT if not dark else COBALT_LT), alignment=PP_ALIGN.RIGHT)


def _add_notes(slide, content):
    notes = content.get('speaker_notes', '')
    if notes:
        slide.notes_slide.notes_text_frame.text = notes


def content_slide(slide, content, layout, slide_idx, total, title=None):
    """White slide, the picture panel when it has pictures, the title, the footer, the notes. Returns the text
    width (inches)."""
    set_slide_bg(slide, WHITE)
    if has_panel(content, layout):
        draw_panel(slide)
    width = text_width(content, layout)
    title_block(slide, content.get('title', '') if title is None else title, width)
    footer(slide, slide_idx, total)
    _add_notes(slide, content)
    return width


def dark_slide(slide):
    """Title, section and closing slides: the primary colour with two soft accent circles bleeding off the edge."""
    set_slide_bg(slide, NAVY)
    add_oval(slide, SLIDE_WIDTH - Inches(5.2), Inches(-2.4), Inches(8), Inches(8), COBALT, transparency=0.82)
    add_oval(slide, SLIDE_WIDTH - Inches(2.6), Inches(3.9), Inches(5), Inches(5), COBALT_LT, transparency=0.9)


def body_top(height):
    """Where a content block `height` inches tall starts so it sits a little above the middle of the body."""
    return BODY_TOP + max(0.0, (BODY_BOTTOM - BODY_TOP - height) * 0.4)


def grid(n, width, top, height, cols, gap=0.35):
    """Cell boxes (x, y, w, h in inches) for n items in `cols` columns filling width x height from (M, top)."""
    rows = -(-n // cols)
    w = (width - gap * (cols - 1)) / cols
    h = (height - gap * (rows - 1)) / rows
    return [(M + (i % cols) * (w + gap), top + (i // cols) * (h + gap), w, h) for i in range(n)]


def text_lines(text, width_in, pt):
    """Estimated number of lines `text` takes in a box `width_in` inches wide at `pt` points."""
    per_line = max(1, int((width_in * 72 - 14) / (pt * 0.52)))
    return sum(max(1, -(-len(par) // per_line)) for par in str(text or '').split('\n'))


CARD_PAD, CARD_ICON = 0.38, 0.62


def card_height(w, heading, detail, heading_pt=20, detail_pt=15):
    """The height a point card needs for its text (inches)."""
    inner = w - 2 * CARD_PAD
    return (2 * CARD_PAD + CARD_ICON + 0.3 + text_lines(heading, inner, heading_pt) * heading_pt * 1.25 / 72 + 0.15
            + (text_lines(detail, inner, detail_pt) * detail_pt * 1.3 / 72 if detail else 0))


def point_card(slide, x, y, w, h, icon, number, heading, detail, heading_pt=20, detail_pt=15):
    """A point as a card: marker on top, heading, detail."""
    add_rounded_rect(slide, Inches(x), Inches(y), Inches(w), Inches(h), CANVAS)
    pad = CARD_PAD
    add_marker(slide, icon, number, Inches(x + pad), Inches(y + pad), Inches(CARD_ICON))
    head_h = text_lines(heading, w - 2 * pad, heading_pt) * heading_pt * 1.25 / 72 + 0.1
    top = y + pad + CARD_ICON + 0.25
    add_textbox(slide, Inches(x + pad - 0.05), Inches(top), Inches(w - 2 * pad + 0.1), Inches(head_h), heading,
                font_size=heading_pt, bold=True, color=NAVY, font_name=FONT_HEADING, spacing=1.0)
    add_textbox(slide, Inches(x + pad - 0.05), Inches(top + head_h + 0.05), Inches(w - 2 * pad + 0.1),
                Inches(max(0.5, y + h - pad - top - head_h)), detail, font_size=detail_pt, color=SLATE)


def point_row(slide, x, y, w, h, icon, number, heading, detail, heading_pt=18, detail_pt=14, marker=0.5):
    """A point as a row: marker on the left, heading and detail beside it."""
    add_marker(slide, icon, number, Inches(x), Inches(y + 0.02), Inches(marker))
    tx = x + marker + 0.25
    add_textbox(slide, Inches(tx), Inches(y - 0.04), Inches(w - marker - 0.25), Inches(0.5), heading,
                font_size=heading_pt, bold=True, color=NAVY, font_name=FONT_HEADING, spacing=1.0)
    if detail:
        add_textbox(slide, Inches(tx), Inches(y + 0.4), Inches(w - marker - 0.25), Inches(max(0.4, h - 0.45)), detail,
                    font_size=detail_pt, color=SLATE)


# ══════════════════════════════════════════════
#  LAYOUT RENDERERS
# ══════════════════════════════════════════════

def render_title(slide, content, slide_idx=0, total=0):
    dark_slide(slide)
    add_rect(slide, Inches(M + 0.05), Inches(2.35), Inches(0.7), Inches(0.08), COBALT_LT)
    add_textbox(slide, Inches(M), Inches(2.6), Inches(8.6), Inches(2.3), content.get('title', ''),
                font_size=46, bold=True, color=WHITE, font_name=FONT_HEADING, spacing=1.0)
    add_textbox(slide, Inches(M), Inches(4.95), Inches(7.8), Inches(1.4), content.get('subtitle', ''),
                font_size=20, color=blend(WHITE, NAVY, 0.25))
    _add_notes(slide, content)


def render_section_divider(slide, content, slide_idx=0, total=0):
    dark_slide(slide)
    add_rect(slide, Inches(M + 0.05), Inches(2.75), Inches(0.7), Inches(0.08), COBALT_LT)
    add_textbox(slide, Inches(M), Inches(3.0), Inches(8.6), Inches(1.6), content.get('title', ''),
                font_size=40, bold=True, color=WHITE, font_name=FONT_HEADING, spacing=1.0)
    add_textbox(slide, Inches(M), Inches(4.65), Inches(7.8), Inches(1.2), content.get('subtitle', ''),
                font_size=20, color=blend(WHITE, NAVY, 0.25))
    footer(slide, slide_idx, total, dark=True)


def render_closing(slide, content, slide_idx=0, total=0):
    dark_slide(slide)
    add_textbox(slide, Inches(M), Inches(0.75), Inches(6), Inches(0.4), 'KEY TAKEAWAYS', font_size=13, bold=True,
                color=COBALT_LT)
    add_textbox(slide, Inches(M) - Inches(0.05), Inches(1.15), Inches(10), Inches(1.0), content.get('title', 'Key takeaways'),
                font_size=34, bold=True, color=WHITE, font_name=FONT_HEADING, spacing=1.0)
    takeaways = content.get('takeaways', [])[:5]
    cta = (content.get('call_to_action') or '').strip()
    area = (5.65 if cta else 6.6) - 2.45
    per = min(area / max(len(takeaways), 1), 0.95)
    y = 2.45
    for t in takeaways:
        add_icon(slide, 'check', Inches(M), Inches(y + 0.02), Inches(0.42), COBALT)
        add_textbox(slide, Inches(M + 0.65), Inches(y - 0.03), Inches(9.2), Inches(per), t, font_size=19, color=WHITE)
        y += per
    if cta:
        add_rounded_rect(slide, Inches(M), Inches(5.85), Inches(9.8), Inches(0.75), COBALT, radius=0.12)
        add_textbox(slide, Inches(M + 0.3), Inches(5.85), Inches(9.3), Inches(0.75), cta, font_size=17, bold=True,
                    color=WHITE, anchor='ctr')
    _add_notes(slide, content)


def render_bullets(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'bullets', slide_idx, total)
    bullets = content.get('bullets', [])[:6]
    n = len(bullets)
    if not n:
        return
    body_h = BODY_BOTTOM - BODY_TOP
    if has_panel(content, 'bullets') or n >= 5:
        # A list: beside a picture, or too many points for cards.
        cols = 2 if (n >= 5 and not has_panel(content, 'bullets')) else 1
        cells = grid(n, width, BODY_TOP, body_h if cols == 1 else body_h, cols, gap=0.35)
        rows = -(-n // cols)
        row_h = min(body_h / rows, 1.35)
        top = body_top(rows * row_h - 0.25)
        for i, (b, (x, _, w, _)) in enumerate(zip(bullets, cells)):
            y = top + (i // cols) * row_h
            point_row(slide, x, y, w, row_h, b.get('icon'), i + 1, b.get('heading', ''), b.get('detail', ''))
        return
    # 1-4 points: cards, side by side (4: two by two, each a row inside).
    if n == 4:
        h4 = min(body_h, 2 * 1.75 + 0.35)
        for i, (b, (x, y, w, h)) in enumerate(zip(bullets, grid(4, width, body_top(h4), h4, 2))):
            add_rounded_rect(slide, Inches(x), Inches(y), Inches(w), Inches(h), CANVAS)
            point_row(slide, x + 0.35, y + 0.4, w - 0.7, h - 0.6, b.get('icon'), i + 1, b.get('heading', ''),
                      b.get('detail', ''), heading_pt=19, detail_pt=14, marker=0.6)
        return
    w = (width - 0.35 * (n - 1)) / n
    card_h = min(body_h, max(card_height(w, b.get('heading', ''), b.get('detail', '')) for b in bullets))
    for i, (b, (x, y, w, h)) in enumerate(zip(bullets, grid(n, width, body_top(card_h), card_h, n))):
        point_card(slide, x, y, w, h, b.get('icon'), i + 1, b.get('heading', ''), b.get('detail', ''))


def render_icon_grid(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'icon_grid', slide_idx, total)
    items = content.get('items', [])[:6]
    n = len(items)
    if not n:
        return
    cols = n if n <= 3 else (2 if n == 4 or has_panel(content, 'icon_grid') else 3)
    rows = -(-n // cols)
    w = (width - 0.35 * (cols - 1)) / cols
    one_row = max(card_height(w, it.get('label', ''), it.get('description', '')) for it in items)
    height = min(BODY_BOTTOM - BODY_TOP, 2.0 * rows + 0.35 * (rows - 1) if rows > 1 else one_row)
    for i, (it, (x, y, w, h)) in enumerate(zip(items, grid(n, width, body_top(height), height, cols))):
        if rows == 1:
            point_card(slide, x, y, w, h, it.get('icon'), i + 1, it.get('label', ''), it.get('description', ''))
        else:
            add_rounded_rect(slide, Inches(x), Inches(y), Inches(w), Inches(h), CANVAS)
            point_row(slide, x + 0.3, y + 0.3, w - 0.6, h - 0.45, it.get('icon'), i + 1, it.get('label', ''),
                      it.get('description', ''), heading_pt=17, detail_pt=13, marker=0.55)


def render_checklist(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'checklist', slide_idx, total)
    items = content.get('items', [])[:8]
    n = len(items)
    if not n:
        return
    cols = 2 if n > 5 and not has_panel(content, 'checklist') else 1
    col_w = (width - 0.5 * (cols - 1)) / cols
    rows = -(-n // cols)
    row_h = min((BODY_BOTTOM - BODY_TOP) / rows, 1.2)
    top = body_top(rows * row_h - 0.3)
    for i, it in enumerate(items):
        x = M + (i // rows) * (col_w + 0.5)
        y = top + (i % rows) * row_h
        add_icon(slide, 'check', Inches(x), Inches(y + 0.02), Inches(0.44))
        add_textbox(slide, Inches(x + 0.65), Inches(y - 0.04), Inches(col_w - 0.65), Inches(0.5), it.get('step', ''),
                    font_size=18, bold=True, color=NAVY, font_name=FONT_HEADING, spacing=1.0)
        if it.get('detail'):
            add_textbox(slide, Inches(x + 0.65), Inches(y + 0.4), Inches(col_w - 0.65), Inches(max(0.4, row_h - 0.5)),
                        it.get('detail', ''), font_size=14, color=SLATE)


def render_process_flow(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'process_flow', slide_idx, total)
    steps = content.get('steps', [])[:7]
    n = len(steps)
    if not n:
        return
    col_w = width / n
    circle = 0.72
    cy = body_top(3.4)
    # The line runs through the circles, from the first to the last.
    add_line(slide, Inches(M + col_w / 2), Inches(cy + circle / 2), Inches(M + col_w * (n - 0.5)), Inches(cy + circle / 2),
             BORDER, width_pt=2.5)
    for i, s in enumerate(steps):
        cx = M + col_w * i + col_w / 2
        add_oval(slide, Inches(cx - circle / 2), Inches(cy), Inches(circle), Inches(circle), COBALT)
        add_textbox(slide, Inches(cx - circle / 2), Inches(cy), Inches(circle), Inches(circle), str(i + 1), font_size=20,
                    bold=True, color=WHITE, alignment=PP_ALIGN.CENTER, anchor='ctr', font_name=FONT_HEADING)
        add_textbox(slide, Inches(cx - col_w / 2 + 0.1), Inches(cy + circle + 0.3), Inches(col_w - 0.2), Inches(0.85),
                    s.get('label', ''), font_size=18 if n <= 5 else 16, bold=True, color=NAVY, alignment=PP_ALIGN.CENTER,
                    font_name=FONT_HEADING, spacing=1.0)
        add_textbox(slide, Inches(cx - col_w / 2 + 0.15), Inches(cy + circle + 1.2), Inches(col_w - 0.3), Inches(2.4),
                    s.get('detail', ''), font_size=14 if n <= 5 else 13, color=SLATE, alignment=PP_ALIGN.CENTER)


def render_timeline(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'timeline', slide_idx, total)
    events = content.get('events', [])[:7]
    n = len(events)
    if not n:
        return
    col_w = width / n
    line_y = body_top(3.5) + 1.0
    add_line(slide, Inches(M), Inches(line_y), Inches(M + width), Inches(line_y), BORDER, width_pt=2.5)
    for i, e in enumerate(events):
        cx = M + col_w * i + col_w / 2
        add_textbox(slide, Inches(cx - col_w / 2 + 0.1), Inches(line_y - 0.95), Inches(col_w - 0.2), Inches(0.6),
                    e.get('date', ''), font_size=17, bold=True, color=COBALT, alignment=PP_ALIGN.CENTER, font_name=FONT_HEADING)
        add_oval(slide, Inches(cx - 0.14), Inches(line_y - 0.14), Inches(0.28), Inches(0.28), COBALT)
        add_textbox(slide, Inches(cx - col_w / 2 + 0.1), Inches(line_y + 0.35), Inches(col_w - 0.2), Inches(0.85),
                    e.get('label', ''), font_size=17, bold=True, color=NAVY, alignment=PP_ALIGN.CENTER,
                    font_name=FONT_HEADING, spacing=1.0)
        add_textbox(slide, Inches(cx - col_w / 2 + 0.15), Inches(line_y + 1.2), Inches(col_w - 0.3), Inches(2.1),
                    e.get('detail', ''), font_size=13, color=SLATE, alignment=PP_ALIGN.CENTER)


def render_key_stats(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'key_stats', slide_idx, total)
    stats = content.get('stats', [])[:6]
    n = len(stats)
    if not n:
        return
    cols = n if n <= 3 else (2 if n == 4 or has_panel(content, 'key_stats') else 3)
    rows = -(-n // cols)
    height = min(BODY_BOTTOM - BODY_TOP, 3.4 if rows == 1 else 4.7)
    for s, (x, y, w, h) in zip(stats, grid(n, width, body_top(height), height, cols)):
        add_rounded_rect(slide, Inches(x), Inches(y), Inches(w), Inches(h), CANVAS)
        pad = 0.35
        add_textbox(slide, Inches(x + pad - 0.05), Inches(y + pad - 0.05), Inches(w - 2 * pad + 0.1), Inches(1.0),
                    s.get('value', ''), font_size=44 if rows == 1 else 34, bold=True, color=COBALT, font_name=FONT_HEADING,
                    spacing=1.0)
        add_textbox(slide, Inches(x + pad - 0.05), Inches(y + pad + (1.05 if rows == 1 else 0.8)), Inches(w - 2 * pad + 0.1),
                    Inches(0.5), s.get('label', ''), font_size=16, bold=True, color=NAVY, font_name=FONT_HEADING)
        add_textbox(slide, Inches(x + pad - 0.05), Inches(y + pad + (1.55 if rows == 1 else 1.25)), Inches(w - 2 * pad + 0.1),
                    Inches(max(0.4, h - pad * 2 - 1.5)), s.get('detail', ''), font_size=13, color=SLATE)


def render_stat_focus(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'stat_focus', slide_idx, total)
    add_textbox(slide, Inches(M - 0.08), Inches(BODY_TOP), Inches(width), Inches(1.9), content.get('stat_value', ''),
                font_size=110, bold=True, color=COBALT, font_name=FONT_HEADING, spacing=0.9)
    add_textbox(slide, Inches(M), Inches(BODY_TOP + 2.0), Inches(width), Inches(0.6), content.get('stat_label', ''),
                font_size=24, bold=True, color=NAVY, font_name=FONT_HEADING)
    add_textbox(slide, Inches(M), Inches(BODY_TOP + 2.7), Inches(min(width, 8.5)), Inches(1.8), content.get('context', ''),
                font_size=18, color=SLATE)


def render_big_idea(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)
    panel = has_panel(content, 'big_idea')
    if panel:
        draw_panel(slide)
    width = text_width(content, 'big_idea')
    add_rect(slide, Inches(M), Inches(1.9), Inches(0.1), Inches(2.6), COBALT)
    add_textbox(slide, Inches(M + 0.4), Inches(1.75), Inches(width - 0.4), Inches(3.0), content.get('statement', ''),
                font_size=40 if not panel else 34, bold=True, color=NAVY, font_name=FONT_HEADING, spacing=1.0, anchor='ctr')
    add_textbox(slide, Inches(M + 0.4), Inches(5.0), Inches(min(width - 0.4, 9)), Inches(1.6), content.get('supporting', ''),
                font_size=19, color=SLATE)
    footer(slide, slide_idx, total)
    _add_notes(slide, content)


def render_quote_highlight(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'quote_highlight', slide_idx, total)
    add_textbox(slide, Inches(M - 0.1), Inches(BODY_TOP - 0.45), Inches(1.6), Inches(1.6), '“', font_size=120,
                bold=True, color=blend(COBALT, WHITE, 0.55), font_name='Georgia')
    add_textbox(slide, Inches(M + 0.15), Inches(BODY_TOP + 0.55), Inches(width - 0.15), Inches(2.4), content.get('quote_text', ''),
                font_size=26, italic=True, color=NAVY, font_name=FONT_HEADING)
    add_textbox(slide, Inches(M + 0.15), Inches(BODY_TOP + 3.05), Inches(width - 0.15), Inches(0.5),
                f"— {content.get('attribution', '')}", font_size=16, bold=True, color=COBALT)
    add_textbox(slide, Inches(M + 0.15), Inches(BODY_TOP + 3.65), Inches(min(width - 0.15, 9)), Inches(1.0),
                content.get('commentary', ''), font_size=15, color=SLATE)


def render_two_column(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'two_column', slide_idx, total)
    verdict = (content.get('verdict') or '').strip()
    height = (BODY_BOTTOM - BODY_TOP) - (1.0 if verdict else 0)
    cells = grid(2, width, BODY_TOP, height, 2, gap=0.4)
    for (x, y, w, h), (head, items) in zip(cells, [
        (content.get('column_a_heading', ''), content.get('column_a_bullets', [])),
        (content.get('column_b_heading', ''), content.get('column_b_bullets', [])),
    ]):
        add_rounded_rect(slide, Inches(x), Inches(y), Inches(w), Inches(h), CANVAS)
        add_textbox(slide, Inches(x + 0.35), Inches(y + 0.3), Inches(w - 0.7), Inches(0.6), head, font_size=21, bold=True,
                    color=NAVY, font_name=FONT_HEADING)
        add_rect(slide, Inches(x + 0.4), Inches(y + 0.95), Inches(0.45), Inches(0.05), COBALT)
        items = items[:5]
        per = min((h - 1.3) / max(len(items), 1), 0.85)
        for k, t in enumerate(items):
            iy = y + 1.25 + k * per
            add_oval(slide, Inches(x + 0.42), Inches(iy + 0.13), Inches(0.1), Inches(0.1), COBALT)
            add_textbox(slide, Inches(x + 0.65), Inches(iy), Inches(w - 1.0), Inches(per), t, font_size=16, color=SLATE)
    if verdict:
        add_rounded_rect(slide, Inches(M), Inches(BODY_BOTTOM - 0.75), Inches(width), Inches(0.75), blend(COBALT, WHITE, 0.88))
        add_textbox(slide, Inches(M + 0.3), Inches(BODY_BOTTOM - 0.75), Inches(width - 0.6), Inches(0.75), verdict,
                    font_size=16, bold=True, color=NAVY, anchor='ctr')


def _cell_border(cell, edge, color=None):
    """One edge of a table cell: a thin line in `color`, or none."""
    tc_pr = cell._tc.get_or_add_tcPr()
    tag = {'top': 'a:lnT', 'bottom': 'a:lnB', 'left': 'a:lnL', 'right': 'a:lnR'}[edge]
    for old in tc_pr.findall(qn(tag)):
        tc_pr.remove(old)
    ln = tc_pr.makeelement(qn(tag), {'w': str(Pt(1) if color else 0), 'cmpd': 'sng'})
    if color:
        fill = ln.makeelement(qn('a:solidFill'), {})
        clr = fill.makeelement(qn('a:srgbClr'), {'val': str(color)})
        fill.append(clr)
        ln.append(fill)
    else:
        ln.append(ln.makeelement(qn('a:noFill'), {}))
    tc_pr.append(ln)


def render_comparison_table(slide, content, slide_idx=0, total=0):
    width = content_slide(slide, content, 'comparison_table', slide_idx, total)
    columns = content.get('columns', [])
    rows = content.get('rows', [])[:8]
    if not columns:
        return
    n_rows = len(rows) + 1
    row_h = min(0.72, (BODY_BOTTOM - BODY_TOP) / n_rows)
    shape = slide.shapes.add_table(n_rows, len(columns), Inches(M), Inches(body_top(row_h * n_rows)), Inches(width),
                                   Inches(row_h * n_rows))
    table = shape.table
    # No built-in style: our own header and thin rules only.
    style = shape._element.graphic.graphicData.tbl.tblPr.find(qn('a:tableStyleId'))
    if style is not None:
        style.text = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'
    table.first_row = True
    table.horz_banding = False
    size = 17 if len(columns) <= 3 else 15
    for r in range(n_rows):
        table.rows[r].height = Inches(row_h)
        for c in range(len(columns)):
            cell = table.cell(r, c)
            text = columns[c] if r == 0 else (rows[r - 1][c] if c < len(rows[r - 1]) else '')
            cell.fill.solid()
            cell.fill.fore_color.rgb = NAVY if r == 0 else WHITE
            cell.margin_left = cell.margin_right = Inches(0.15)
            cell.vertical_anchor = 1  # middle
            tf = cell.text_frame
            tf.text = str(text or '')
            p = tf.paragraphs[0]
            p.font.size = Pt(size if r else size - 1)
            p.font.bold = r == 0 or c == 0
            p.font.name = FONT_HEADING if (r == 0 or c == 0) else FONT_BODY
            p.font.color.rgb = WHITE if r == 0 else (NAVY if c == 0 else SLATE)
            for edge in ('top', 'left', 'right'):
                _cell_border(cell, edge, None)
            _cell_border(cell, 'bottom', BORDER if r else None)


def render_diagram(slide, content, slide_idx=0, total=0):
    content_slide(slide, content, 'diagram', slide_idx, total)
    caption = (content.get('caption') or '').strip()
    box_top = BODY_TOP - 0.1
    box_h = (BODY_BOTTOM - box_top) - (0.5 if caption else 0)
    box_left, box_w = Inches(M), SLIDE_WIDTH - Inches(2 * M)
    path = content.get('diagram_path')
    if path and Path(path).exists():
        img = image_settings(content.get('image'))
        if None not in (img['x'], img['y'], img['w']):
            add_picture_at(slide, path, img['x'], img['y'], img['w'], img['crop'])
        else:
            add_picture_fit(slide, path, box_left, Inches(box_top), box_w, Inches(box_h), img['crop'])
    else:
        add_textbox(slide, box_left, Inches(box_top), box_w, Inches(box_h), 'Diagram not available',
                    font_size=16, color=SLATE_LT, alignment=PP_ALIGN.CENTER, anchor='ctr')
    if caption:
        add_textbox(slide, box_left, Inches(box_top + box_h + 0.05), box_w, Inches(0.45), caption,
                    font_size=13, color=SLATE, alignment=PP_ALIGN.CENTER)


def render_figure(slide, content, slide_idx=0, total=0):
    """A slide built around a figure: the title over a soft band; the picture itself is drawn by render_pictures."""
    set_slide_bg(slide, WHITE)
    add_rect(slide, 0, Inches(BODY_TOP - 0.3), SLIDE_WIDTH, SLIDE_HEIGHT - Inches(BODY_TOP - 0.3), CANVAS)
    title_block(slide, content.get('title', ''), 13.333 - 2 * M)
    footer(slide, slide_idx, total)
    _add_notes(slide, content)


# ── Registry ──

RENDERERS = {
    'title':            render_title,
    'bullets':          render_bullets,
    'two_column':       render_two_column,
    'stat_focus':       render_stat_focus,
    'quote_highlight':  render_quote_highlight,
    'checklist':        render_checklist,
    'closing':          render_closing,
    'section_divider':  render_section_divider,
    'big_idea':         render_big_idea,
    'timeline':         render_timeline,
    'process_flow':     render_process_flow,
    'icon_grid':        render_icon_grid,
    'comparison_table': render_comparison_table,
    'key_stats':        render_key_stats,
    'diagram':          render_diagram,
    'figure':           render_figure,
}


def blank_layout_of(prs):
    """The layout to draw on: one named Blank, else the one with the fewest placeholders. With a company
    template this keeps its master (logos, footer art) behind our shapes."""
    layouts = list(prs.slide_layouts)
    named = [l for l in layouts if l.name.strip().lower() == 'blank']
    return named[0] if named else min(layouts, key=lambda l: len(l.placeholders))


def remove_existing_slides(prs):
    """A company template may ship with example slides; the deck starts empty."""
    id_list = prs.slides._sldIdLst
    for sld_id in list(id_list):
        prs.part.drop_rel(sld_id.rId)
        id_list.remove(sld_id)


def render_deck(outline, output_path, template_path=None):
    if template_path and Path(template_path).exists():
        prs = Presentation(template_path)
        remove_existing_slides(prs)
    else:
        prs = Presentation()

    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT
    blank_layout = blank_layout_of(prs)

    apply_theme(outline.get('theme'))
    slides_data = outline.get('slides', [])
    total = len(slides_data)

    for i, slide_data in enumerate(slides_data):
        layout = slide_data.get('layout', 'bullets')
        content = slide_data.get('content', {})
        if not content:
            continue
        slide = prs.slides.add_slide(blank_layout)
        RENDERERS.get(layout, render_bullets)(slide, content, slide_idx=i + 1, total=total)
        render_pictures(slide, content, layout)

    prs.save(output_path)
    return output_path


def main():
    if len(sys.argv) < 3:
        print('Usage: render_pptx.py <input.json> <output.pptx> [template.pptx]', file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    template_path = sys.argv[3] if len(sys.argv) > 3 else None

    with open(input_path, 'r', encoding='utf-8') as f:
        outline = json.load(f)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    render_deck(outline, output_path, template_path)
    print(json.dumps({'ok': True, 'path': output_path}))


if __name__ == '__main__':
    main()
