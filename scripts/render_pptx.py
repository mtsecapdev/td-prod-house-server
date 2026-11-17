"""
Render a slide deck generation JSON into a .pptx file using python-pptx.

Usage:
    python render_pptx.py <input.json> <output.pptx> [template.pptx]

Input JSON shape (the generation's outline object):
    { "slides": [ { "layout": "title|bullets|...", "content": { ... } }, ... ] }
"""

import json
import struct
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

# ── Design tokens ──
NAVY       = RGBColor(0x0F, 0x2B, 0x48)
NAVY_MID   = RGBColor(0x16, 0x3A, 0x60)
NAVY_LIGHT = RGBColor(0x1E, 0x4A, 0x7A)
COBALT     = RGBColor(0x25, 0x63, 0xEB)
COBALT_LT  = RGBColor(0x60, 0xA5, 0xFA)
SLATE      = RGBColor(0x47, 0x55, 0x69)
SLATE_LT   = RGBColor(0x94, 0xA3, 0xB8)
BORDER     = RGBColor(0xE2, 0xE8, 0xF0)
CANVAS     = RGBColor(0xF0, 0xF4, 0xF8)
WHITE      = RGBColor(0xFF, 0xFF, 0xFF)
GREEN      = RGBColor(0x10, 0xB9, 0x81)
AMBER      = RGBColor(0xF5, 0x9E, 0x0B)

SLIDE_WIDTH  = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)

FONT_HEADING = 'Calibri'
FONT_BODY    = 'Calibri'


def hex_color(value):
    value = value.lstrip('#')
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


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


# ── Helpers ──

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


def add_textbox(slide, left, top, width, height, text, font_size=18,
                bold=False, color=None, alignment=PP_ALIGN.LEFT,
                font_name=None, italic=False, anchor=None):
    color = color or NAVY  # resolved at call time so the template applies
    font_size = fitted_size(text, width, height, font_size)
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    if anchor:
        tf.paragraphs[0].alignment = alignment
        tf_elem = tf._txBody
        body_pr = tf_elem.find(qn('a:bodyPr'))
        if body_pr is not None:
            body_pr.set('anchor', anchor)
    p = tf.paragraphs[0]
    p.text = text or ''
    p.font.size = Pt(font_size)
    p.font.bold = bold
    p.font.italic = italic
    p.font.color.rgb = color
    p.font.name = font_name or FONT_BODY
    p.alignment = alignment
    return txBox


def add_rich_textbox(slide, left, top, width, height, runs, alignment=PP_ALIGN.LEFT):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = alignment
    for i, run_spec in enumerate(runs):
        if i == 0:
            r = p.runs[0] if p.runs else p.add_run()
        else:
            r = p.add_run()
        r.text = run_spec.get('text', '')
        r.font.size = Pt(run_spec.get('size', 14))
        r.font.bold = run_spec.get('bold', False)
        r.font.italic = run_spec.get('italic', False)
        r.font.color.rgb = run_spec.get('color', NAVY)
        r.font.name = run_spec.get('font', FONT_BODY)
    return txBox


def add_rect(slide, left, top, width, height, fill_color, line=False):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if not line:
        shape.line.fill.background()
    return shape


def add_rounded_rect(slide, left, top, width, height, fill_color):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    shape.line.fill.background()
    shape.adjustments[0] = 0.04
    return shape


def add_oval(slide, left, top, width, height, fill_color, transparency=0):
    shape = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    shape.line.fill.background()
    if transparency > 0:
        sp_pr = shape._element.find(qn('p:spPr'))
        solid_fill = sp_pr.find(qn('a:solidFill'))
        if solid_fill is not None:
            srgb = solid_fill.find(qn('a:srgbClr'))
            if srgb is not None:
                alpha = srgb.makeelement(qn('a:alpha'), {})
                alpha.set('val', str(int((1 - transparency) * 100000)))
                srgb.append(alpha)
    return shape


def add_slide_number(slide, slide_idx, total):
    add_textbox(slide, SLIDE_WIDTH - Inches(1.2), SLIDE_HEIGHT - Inches(0.5),
                Inches(1), Inches(0.35),
                f'{slide_idx}/{total}', font_size=9, color=SLATE_LT,
                alignment=PP_ALIGN.RIGHT)


def png_size(path):
    """(width, height) in pixels, read from the PNG header."""
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Not a PNG: {path}')
    return struct.unpack('>II', head[16:24])


def add_picture_fit(slide, path, left, top, max_w, max_h):
    """Place an image as large as fits in the box, keeping its aspect ratio, centred."""
    w_px, h_px = png_size(path)
    scale = min(int(max_w) / w_px, int(max_h) / h_px)
    w, h = int(w_px * scale), int(h_px * scale)
    slide.shapes.add_picture(path, int(left) + (int(max_w) - w) // 2, int(top) + (int(max_h) - h) // 2, w, h)


def _add_notes(slide, content):
    notes = content.get('speaker_notes', '')
    if notes:
        notes_slide = slide.notes_slide
        notes_slide.notes_text_frame.text = notes


# ══════════════════════════════════════════════
#  LAYOUT RENDERERS
# ══════════════════════════════════════════════

def render_title(slide, content, **kw):
    set_slide_bg(slide, NAVY)

    # Decorative geometric shapes
    add_oval(slide, SLIDE_WIDTH - Inches(4), Inches(-2),
             Inches(6), Inches(6), COBALT, transparency=0.92)
    add_oval(slide, Inches(-2), SLIDE_HEIGHT - Inches(3),
             Inches(5), Inches(5), NAVY_LIGHT, transparency=0.88)

    # Top accent line
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(0.06), COBALT)

    # Bottom accent bar
    add_rect(slide, Inches(0), SLIDE_HEIGHT - Inches(0.06),
             SLIDE_WIDTH, Inches(0.06), COBALT)

    # Title
    add_textbox(slide, Inches(1.5), Inches(2.0), Inches(10), Inches(2.2),
                content.get('title', ''), font_size=48, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    # Divider
    add_rect(slide, Inches(1.5), Inches(4.4), Inches(1.2), Inches(0.06), COBALT)

    # Subtitle
    add_textbox(slide, Inches(1.5), Inches(4.8), Inches(9), Inches(1.5),
                content.get('subtitle', ''), font_size=22, color=SLATE_LT)


def render_bullets(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)

    # Left accent panel
    add_rect(slide, Inches(0), Inches(0), Inches(0.5), SLIDE_HEIGHT, NAVY)

    # Title area with canvas background
    add_rect(slide, Inches(0.5), Inches(0), SLIDE_WIDTH - Inches(0.5), Inches(1.5), CANVAS)

    # Title
    add_textbox(slide, Inches(1.2), Inches(0.35), Inches(10.5), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=NAVY,
                font_name=FONT_HEADING)

    # Bottom border of title area
    add_rect(slide, Inches(0.5), Inches(1.48), SLIDE_WIDTH - Inches(0.5), Inches(0.04), COBALT)

    bullets = content.get('bullets', [])
    num_bullets = len(bullets)
    available = 5.3
    per_bullet = min(available / max(num_bullets, 1), 1.3)

    y = Inches(1.8)
    for i, bullet in enumerate(bullets):
        heading = bullet.get('heading', '')
        detail = bullet.get('detail', '')

        # Alternating row tint
        if i % 2 == 0:
            add_rect(slide, Inches(0.5), y - Inches(0.05),
                     SLIDE_WIDTH - Inches(0.5), Inches(per_bullet),
                     CANVAS)

        # Numbered circle badge
        badge_size = Inches(0.45)
        add_oval(slide, Inches(1.0), y + Inches(0.02),
                 badge_size, badge_size, COBALT)
        add_textbox(slide, Inches(1.0), y + Inches(0.04),
                    badge_size, badge_size,
                    str(i + 1), font_size=14, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

        # Heading
        add_textbox(slide, Inches(1.7), y, Inches(10), Inches(0.4),
                    heading, font_size=17, bold=True, color=NAVY)

        # Detail
        detail_h = Inches(max(per_bullet - 0.5, 0.4))
        add_textbox(slide, Inches(1.7), y + Inches(0.38), Inches(10), detail_h,
                    detail, font_size=13, color=SLATE)

        y += Inches(per_bullet)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_two_column(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, CANVAS)

    # Title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), WHITE)
    add_textbox(slide, Inches(0.8), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=NAVY,
                font_name=FONT_HEADING)
    add_rect(slide, Inches(0), Inches(1.48), SLIDE_WIDTH, Inches(0.04), BORDER)

    # Column cards (shorter when a verdict line sits underneath)
    verdict = (content.get('verdict') or '').strip()
    card_top = Inches(1.9)
    card_h = Inches(4.3) if verdict else Inches(5.1)
    card_w = Inches(5.6)
    gap = Inches(0.5)
    left_x = Inches(0.8)
    right_x = left_x + card_w + gap

    # Column A card
    add_rounded_rect(slide, left_x, card_top, card_w, card_h, WHITE)
    add_rect(slide, left_x, card_top, card_w, Inches(0.06), COBALT)
    add_textbox(slide, left_x + Inches(0.4), card_top + Inches(0.3), card_w - Inches(0.8), Inches(0.5),
                content.get('column_a_heading', ''), font_size=18, bold=True, color=COBALT)

    a_bullets = content.get('column_a_bullets', [])
    y = card_top + Inches(1.0)
    per_item = min(3.8 / max(len(a_bullets), 1), 0.9)
    for b in a_bullets:
        add_textbox(slide, left_x + Inches(0.6), y, card_w - Inches(1.0), Inches(per_item),
                    f'•  {b}', font_size=13, color=SLATE)
        y += Inches(per_item)

    # Column B card
    add_rounded_rect(slide, right_x, card_top, card_w, card_h, WHITE)
    add_rect(slide, right_x, card_top, card_w, Inches(0.06), NAVY)
    add_textbox(slide, right_x + Inches(0.4), card_top + Inches(0.3), card_w - Inches(0.8), Inches(0.5),
                content.get('column_b_heading', ''), font_size=18, bold=True, color=NAVY)

    b_bullets = content.get('column_b_bullets', [])
    y = card_top + Inches(1.0)
    per_item = min(3.8 / max(len(b_bullets), 1), 0.9)
    for b in b_bullets:
        add_textbox(slide, right_x + Inches(0.6), y, card_w - Inches(1.0), Inches(per_item),
                    f'•  {b}', font_size=13, color=SLATE)
        y += Inches(per_item)

    if verdict:
        add_rich_textbox(slide, left_x, card_top + card_h + Inches(0.25), card_w * 2 + gap, Inches(0.6), [
            {'text': 'Verdict:  ', 'size': 15, 'bold': True, 'color': COBALT},
            {'text': verdict, 'size': 15, 'color': NAVY},
        ])

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_stat_focus(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, NAVY)

    # Decorative geometry
    add_oval(slide, SLIDE_WIDTH - Inches(3.5), Inches(-1.5),
             Inches(5), Inches(5), COBALT, transparency=0.9)
    add_oval(slide, Inches(-2), SLIDE_HEIGHT - Inches(3.5),
             Inches(4.5), Inches(4.5), NAVY_LIGHT, transparency=0.85)

    # Title
    add_textbox(slide, Inches(1.2), Inches(0.6), Inches(10), Inches(0.8),
                content.get('title', ''), font_size=24, bold=True, color=SLATE_LT,
                font_name=FONT_HEADING)

    # Central stat card
    card_w = Inches(7)
    card_h = Inches(3.5)
    card_x = (SLIDE_WIDTH - card_w) // 2
    card_y = Inches(1.8)
    add_rounded_rect(slide, card_x, card_y, card_w, card_h, WHITE)

    # Stat value
    add_textbox(slide, card_x, card_y + Inches(0.3), card_w, Inches(1.6),
                content.get('stat_value', ''), font_size=80, bold=True, color=COBALT,
                alignment=PP_ALIGN.CENTER, font_name=FONT_HEADING, anchor='ctr')

    # Divider
    div_w = Inches(1)
    add_rect(slide, (SLIDE_WIDTH - div_w) // 2, card_y + Inches(2.0),
             div_w, Inches(0.05), COBALT)

    # Label
    add_textbox(slide, card_x, card_y + Inches(2.2), card_w, Inches(0.6),
                (content.get('stat_label', '') or '').upper(), font_size=16, bold=True,
                color=SLATE, alignment=PP_ALIGN.CENTER)

    # Context below card
    add_textbox(slide, Inches(2.5), card_y + card_h + Inches(0.3), Inches(8), Inches(1),
                content.get('context', ''), font_size=16, color=SLATE_LT,
                alignment=PP_ALIGN.CENTER)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_quote_highlight(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, CANVAS)

    # Dark left panel
    panel_w = Inches(4.5)
    add_rect(slide, Inches(0), Inches(0), panel_w, SLIDE_HEIGHT, NAVY)

    # Title on the dark panel
    add_textbox(slide, Inches(0.6), Inches(0.8), panel_w - Inches(1.0), Inches(1.2),
                content.get('title', ''), font_size=26, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    # Large decorative quote mark on dark panel
    add_textbox(slide, Inches(0.4), Inches(2.2), Inches(2), Inches(2),
                '“', font_size=120, bold=True, color=COBALT_LT,
                font_name=FONT_HEADING)

    # Attribution on dark panel
    add_textbox(slide, Inches(0.6), SLIDE_HEIGHT - Inches(1.5), panel_w - Inches(1.0), Inches(0.6),
                f'— {content.get("attribution", "")}', font_size=14,
                bold=True, color=COBALT_LT)

    # Quote card on the right
    card_x = panel_w + Inches(0.6)
    card_w = SLIDE_WIDTH - panel_w - Inches(1.2)
    card_y = Inches(1.0)
    card_h = Inches(4.0)
    add_rounded_rect(slide, card_x, card_y, card_w, card_h, WHITE)

    # Cobalt top border on card
    add_rect(slide, card_x, card_y, card_w, Inches(0.06), COBALT)

    # Quote text
    add_textbox(slide, card_x + Inches(0.6), card_y + Inches(0.5),
                card_w - Inches(1.2), card_h - Inches(1.0),
                content.get('quote_text', ''), font_size=20, italic=True, color=NAVY)

    # Commentary below card
    add_textbox(slide, card_x, card_y + card_h + Inches(0.4),
                card_w, Inches(1.5),
                content.get('commentary', ''), font_size=14, color=SLATE)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_checklist(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)

    # Full-width title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), NAVY)
    add_textbox(slide, Inches(1.0), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    items = content.get('items', [])
    num_items = len(items)
    available = 5.3
    per_item = min(available / max(num_items, 1), 1.3)

    # Vertical connector line
    line_x = Inches(1.45)
    y_start = Inches(1.9)
    line_h = Inches(per_item * (num_items - 1) + 0.2) if num_items > 1 else Inches(0)
    if num_items > 1:
        add_rect(slide, line_x, y_start + Inches(0.25), Inches(0.04), line_h, BORDER)

    y = y_start
    for i, item in enumerate(items):
        # Circle badge with number
        badge_size = Inches(0.5)
        add_oval(slide, Inches(1.2), y, badge_size, badge_size, NAVY)
        add_textbox(slide, Inches(1.2), y + Inches(0.02),
                    badge_size, badge_size,
                    str(i + 1), font_size=15, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

        # Step card
        card_x = Inches(2.0)
        card_w = Inches(10.5)
        card_h = Inches(max(per_item - 0.15, 0.6))
        add_rounded_rect(slide, card_x, y - Inches(0.05), card_w, card_h, CANVAS)

        # Step name
        add_textbox(slide, card_x + Inches(0.3), y, card_w - Inches(0.6), Inches(0.4),
                    item.get('step', ''), font_size=16, bold=True, color=NAVY)

        # Detail
        detail_h = Inches(max(per_item - 0.6, 0.3))
        add_textbox(slide, card_x + Inches(0.3), y + Inches(0.38), card_w - Inches(0.6), detail_h,
                    item.get('detail', ''), font_size=12, color=SLATE)

        y += Inches(per_item)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_closing(slide, content, **kw):
    set_slide_bg(slide, NAVY)

    # Decorative elements (mirror title slide)
    add_oval(slide, SLIDE_WIDTH - Inches(4), Inches(-2),
             Inches(6), Inches(6), COBALT, transparency=0.92)
    add_oval(slide, Inches(-2), SLIDE_HEIGHT - Inches(3),
             Inches(5), Inches(5), NAVY_LIGHT, transparency=0.88)

    # Top accent line
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(0.06), COBALT)

    # Title
    add_textbox(slide, Inches(1.5), Inches(0.8), Inches(10), Inches(1.0),
                content.get('title', 'Key Takeaways'), font_size=36, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    # Divider
    add_rect(slide, Inches(1.5), Inches(1.9), Inches(1.2), Inches(0.06), COBALT)

    # Takeaway items
    takeaways = content.get('takeaways', [])
    y = Inches(2.3)
    per_item = min(3.8 / max(len(takeaways), 1), 0.85)

    for i, takeaway in enumerate(takeaways):
        # Checkmark / number badge
        badge_size = Inches(0.4)
        add_oval(slide, Inches(1.5), y + Inches(0.02), badge_size, badge_size, COBALT)
        add_textbox(slide, Inches(1.5), y + Inches(0.04),
                    badge_size, badge_size,
                    '✓', font_size=14, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

        # Takeaway text
        add_textbox(slide, Inches(2.2), y, Inches(9.5), Inches(per_item),
                    takeaway, font_size=17, color=WHITE)

        y += Inches(per_item)

    # Call to action
    cta = content.get('call_to_action', '')
    if cta:
        cta_y = max(y + Inches(0.3), Inches(5.5))
        add_rect(slide, Inches(1.5), cta_y, Inches(10), Inches(0.04), COBALT_LT)
        add_textbox(slide, Inches(1.5), cta_y + Inches(0.2), Inches(10), Inches(0.8),
                    cta, font_size=18, bold=True, color=COBALT_LT)

    # Bottom accent bar
    add_rect(slide, Inches(0), SLIDE_HEIGHT - Inches(0.06),
             SLIDE_WIDTH, Inches(0.06), COBALT)

    _add_notes(slide, content)


def render_section_divider(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, NAVY_MID)

    # Horizontal accent stripe
    add_rect(slide, Inches(0), Inches(3.2), SLIDE_WIDTH, Inches(0.08), COBALT)

    # Decorative circle
    add_oval(slide, SLIDE_WIDTH - Inches(5), Inches(0.5),
             Inches(7), Inches(7), NAVY_LIGHT, transparency=0.88)

    # Section title — large, centered
    add_textbox(slide, Inches(1.5), Inches(2.0), Inches(10), Inches(1.2),
                content.get('title', ''), font_size=44, bold=True, color=WHITE,
                font_name=FONT_HEADING, alignment=PP_ALIGN.LEFT)

    # Subtitle below stripe
    add_textbox(slide, Inches(1.5), Inches(3.6), Inches(9), Inches(1.0),
                content.get('subtitle', ''), font_size=20, color=SLATE_LT)

    add_slide_number(slide, slide_idx, total)


def render_big_idea(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)

    # Large cobalt accent block on left
    add_rect(slide, Inches(0), Inches(0), Inches(1.0), SLIDE_HEIGHT, COBALT)

    # Decorative quote mark
    add_textbox(slide, Inches(1.5), Inches(0.8), Inches(2), Inches(2),
                '"', font_size=140, bold=True, color=BORDER,
                font_name=FONT_HEADING)

    # Statement — the big idea, centered vertically
    add_textbox(slide, Inches(2.0), Inches(2.0), Inches(9.5), Inches(2.5),
                content.get('statement', ''), font_size=38, bold=True, color=NAVY,
                font_name=FONT_HEADING)

    # Divider
    add_rect(slide, Inches(2.0), Inches(4.7), Inches(1.5), Inches(0.06), COBALT)

    # Supporting text
    add_textbox(slide, Inches(2.0), Inches(5.1), Inches(9.5), Inches(1.2),
                content.get('supporting', ''), font_size=18, color=SLATE)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_timeline(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, CANVAS)

    # Title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), WHITE)
    add_textbox(slide, Inches(0.8), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=NAVY,
                font_name=FONT_HEADING)
    add_rect(slide, Inches(0), Inches(1.48), SLIDE_WIDTH, Inches(0.04), COBALT)

    events = content.get('events', [])
    num = len(events)
    if num == 0:
        add_slide_number(slide, slide_idx, total)
        _add_notes(slide, content)
        return

    # Horizontal timeline bar
    bar_y = Inches(3.4)
    margin = Inches(1.2)
    usable_w = SLIDE_WIDTH - margin * 2
    add_rect(slide, margin, bar_y, usable_w, Inches(0.06), NAVY)

    per_event = int(usable_w) // max(num, 1)

    for i, event in enumerate(events):
        cx = int(margin) + per_event * i + per_event // 2

        # Dot on timeline
        dot = Inches(0.35)
        add_oval(slide, cx - int(dot) // 2, int(bar_y) - int(dot) // 2,
                 dot, dot, COBALT)

        # Date label above
        add_textbox(slide, cx - Inches(1.5), bar_y - Inches(1.0),
                    Inches(3), Inches(0.5),
                    event.get('date', ''), font_size=12, bold=True, color=COBALT,
                    alignment=PP_ALIGN.CENTER)

        # Event label above date
        add_textbox(slide, cx - Inches(1.5), bar_y - Inches(1.5),
                    Inches(3), Inches(0.5),
                    event.get('label', ''), font_size=14, bold=True, color=NAVY,
                    alignment=PP_ALIGN.CENTER)

        # Detail below bar
        add_textbox(slide, cx - Inches(1.5), bar_y + Inches(0.4),
                    Inches(3), Inches(1.5),
                    event.get('detail', ''), font_size=11, color=SLATE,
                    alignment=PP_ALIGN.CENTER)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_process_flow(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)

    # Title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), NAVY)
    add_textbox(slide, Inches(1.0), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    steps = content.get('steps', [])
    num = len(steps)
    if num == 0:
        add_slide_number(slide, slide_idx, total)
        _add_notes(slide, content)
        return

    margin = Inches(0.8)
    gap = Inches(0.3)
    usable = SLIDE_WIDTH - margin * 2 - gap * max(num - 1, 0)
    card_w = int(usable) // max(num, 1)
    card_h = Inches(4.5)
    card_y = Inches(2.0)

    for i, step in enumerate(steps):
        x = int(margin) + i * (card_w + int(gap))

        # Card
        add_rounded_rect(slide, x, card_y, card_w, card_h, CANVAS)

        # Step number badge
        badge = Inches(0.55)
        badge_x = x + (card_w - int(badge)) // 2
        add_oval(slide, badge_x, card_y + Inches(0.3), badge, badge, COBALT)
        add_textbox(slide, badge_x, card_y + Inches(0.32),
                    badge, badge,
                    str(i + 1), font_size=18, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

        # Label
        add_textbox(slide, x + Inches(0.2), card_y + Inches(1.1),
                    card_w - Inches(0.4), Inches(0.6),
                    step.get('label', ''), font_size=14, bold=True, color=NAVY,
                    alignment=PP_ALIGN.CENTER)

        # Detail
        add_textbox(slide, x + Inches(0.2), card_y + Inches(1.8),
                    card_w - Inches(0.4), Inches(2.2),
                    step.get('detail', ''), font_size=11, color=SLATE,
                    alignment=PP_ALIGN.CENTER)

        # Arrow between cards
        if i < num - 1:
            arrow_x = x + card_w + int(gap) // 2 - Inches(0.15)
            add_textbox(slide, arrow_x, card_y + Inches(1.8),
                        Inches(0.4), Inches(0.5),
                        '→', font_size=24, bold=True, color=COBALT,
                        alignment=PP_ALIGN.CENTER)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_icon_grid(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, CANVAS)

    # Title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), WHITE)
    add_textbox(slide, Inches(0.8), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=NAVY,
                font_name=FONT_HEADING)
    add_rect(slide, Inches(0), Inches(1.48), SLIDE_WIDTH, Inches(0.04), COBALT)

    items = content.get('items', [])
    num = len(items)
    if num == 0:
        add_slide_number(slide, slide_idx, total)
        _add_notes(slide, content)
        return

    # Grid: 2 or 3 columns
    cols = 3 if num > 4 else 2
    rows_count = (num + cols - 1) // cols

    margin = Inches(0.8)
    gap_x = Inches(0.4)
    gap_y = Inches(0.4)
    card_w = (int(SLIDE_WIDTH) - int(margin) * 2 - int(gap_x) * (cols - 1)) // cols
    available_h = int(SLIDE_HEIGHT) - int(Inches(2.0)) - int(Inches(0.5))
    card_h = min((available_h - int(gap_y) * (rows_count - 1)) // max(rows_count, 1), int(Inches(2.5)))

    grid_top = Inches(1.8)

    for idx, item in enumerate(items):
        col = idx % cols
        row = idx // cols
        x = int(margin) + col * (card_w + int(gap_x))
        y = int(grid_top) + row * (card_h + int(gap_y))

        # Card
        add_rounded_rect(slide, x, y, card_w, card_h, WHITE)

        # Icon circle
        icon_size = Inches(0.6)
        icon_x = x + Inches(0.3)
        icon_y = y + Inches(0.3)
        add_oval(slide, icon_x, icon_y, icon_size, icon_size, COBALT)
        icon_text = (item.get('icon', '') or '●')[:1].upper()
        add_textbox(slide, icon_x, icon_y + Inches(0.02),
                    icon_size, icon_size,
                    icon_text, font_size=16, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

        # Label
        add_textbox(slide, x + Inches(0.3), icon_y + icon_size + Inches(0.15),
                    card_w - Inches(0.6), Inches(0.4),
                    item.get('label', ''), font_size=14, bold=True, color=NAVY)

        # Description
        add_textbox(slide, x + Inches(0.3), icon_y + icon_size + Inches(0.55),
                    card_w - Inches(0.6), Inches(card_h / Inches(1) - 1.5),
                    item.get('description', ''), font_size=11, color=SLATE)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_comparison_table(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)

    # Title bar
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), NAVY)
    add_textbox(slide, Inches(1.0), Inches(0.35), Inches(11), Inches(0.9),
                content.get('title', ''), font_size=30, bold=True, color=WHITE,
                font_name=FONT_HEADING)

    columns = content.get('columns', [])
    rows = content.get('rows', [])
    num_cols = len(columns)
    num_rows = len(rows)

    if num_cols == 0:
        add_slide_number(slide, slide_idx, total)
        _add_notes(slide, content)
        return

    margin = Inches(0.8)
    table_w = int(SLIDE_WIDTH) - int(margin) * 2
    col_w = table_w // max(num_cols, 1)
    row_h = Inches(0.7)
    header_h = Inches(0.7)
    table_top = Inches(2.0)

    # Header row
    for ci, col_name in enumerate(columns):
        x = int(margin) + ci * col_w
        add_rect(slide, x, table_top, col_w, header_h, COBALT)
        add_textbox(slide, x + Inches(0.15), table_top + Inches(0.1),
                    col_w - Inches(0.3), header_h - Inches(0.2),
                    col_name, font_size=14, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER, anchor='ctr')

    # Data rows
    for ri, row in enumerate(rows):
        y = int(table_top) + int(header_h) + ri * int(row_h)
        bg = CANVAS if ri % 2 == 0 else WHITE
        for ci in range(num_cols):
            x = int(margin) + ci * col_w
            cell_text = row[ci] if ci < len(row) else ''
            add_rect(slide, x, y, col_w, row_h, bg)
            # Cell border
            add_rect(slide, x, y + int(row_h) - Inches(0.02), col_w, Inches(0.02), BORDER)
            add_textbox(slide, x + Inches(0.15), y + Inches(0.08),
                        col_w - Inches(0.3), row_h - Inches(0.16),
                        cell_text, font_size=12, color=NAVY,
                        alignment=PP_ALIGN.CENTER, anchor='ctr')

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def _title_bar(slide, title):
    add_rect(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.5), WHITE)
    add_textbox(slide, Inches(0.8), Inches(0.35), Inches(11.5), Inches(0.9),
                title, font_size=30, bold=True, color=NAVY, font_name=FONT_HEADING)
    add_rect(slide, Inches(0), Inches(1.48), SLIDE_WIDTH, Inches(0.04), BORDER)


def render_key_stats(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, CANVAS)
    _title_bar(slide, content.get('title', ''))

    stats = content.get('stats', [])[:6]
    n = len(stats)
    if n:
        cols = n if n <= 3 else (2 if n == 4 else 3)
        rows = (n + cols - 1) // cols
        margin, gap = Inches(0.8), Inches(0.35)
        area_top, area_h = Inches(1.95), Inches(5.0)
        card_w = (int(SLIDE_WIDTH) - 2 * int(margin) - (cols - 1) * int(gap)) // cols
        card_h = (int(area_h) - (rows - 1) * int(gap)) // rows
        value_size = 40 if rows == 1 else 32

        for i, stat in enumerate(stats):
            r, c = divmod(i, cols)
            # Centre a short last row
            in_row = cols if r < rows - 1 else n - cols * (rows - 1)
            row_offset = (cols - in_row) * (card_w + int(gap)) // 2
            x = int(margin) + row_offset + c * (card_w + int(gap))
            y = int(area_top) + r * (card_h + int(gap))

            add_rounded_rect(slide, x, y, card_w, card_h, WHITE)
            add_rect(slide, x, y, card_w, Inches(0.06), COBALT)
            add_textbox(slide, x + Inches(0.3), y + Inches(0.3), card_w - Inches(0.6), Inches(0.9),
                        stat.get('value', ''), font_size=value_size, bold=True, color=COBALT,
                        font_name=FONT_HEADING)
            add_textbox(slide, x + Inches(0.3), y + Inches(1.2), card_w - Inches(0.6), Inches(0.4),
                        (stat.get('label', '') or '').upper(), font_size=12, bold=True, color=NAVY)
            add_textbox(slide, x + Inches(0.3), y + Inches(1.6), card_w - Inches(0.6), card_h - Inches(1.75),
                        stat.get('detail', ''), font_size=12, color=SLATE)

    add_slide_number(slide, slide_idx, total)
    _add_notes(slide, content)


def render_diagram(slide, content, slide_idx=0, total=0):
    set_slide_bg(slide, WHITE)
    _title_bar(slide, content.get('title', ''))

    caption = (content.get('caption') or '').strip()
    box_top = Inches(1.75)
    box_h = Inches(4.85) if caption else Inches(5.35)
    box_left, box_w = Inches(0.8), SLIDE_WIDTH - Inches(1.6)

    path = content.get('diagram_path')
    if path and Path(path).exists():
        add_picture_fit(slide, path, box_left, box_top, box_w, box_h)
    else:
        add_textbox(slide, box_left, box_top, box_w, box_h, 'Diagram not available',
                    font_size=16, color=SLATE_LT, alignment=PP_ALIGN.CENTER, anchor='ctr')

    if caption:
        add_textbox(slide, box_left, box_top + box_h + Inches(0.15), box_w, Inches(0.5),
                    caption, font_size=14, italic=True, color=SLATE, alignment=PP_ALIGN.CENTER)

    add_slide_number(slide, slide_idx, total)
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
}


def render_deck(outline, output_path, template_path=None):
    if template_path and Path(template_path).exists():
        prs = Presentation(template_path)
    else:
        prs = Presentation()

    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT

    blank_layout = prs.slide_layouts[6]  # blank layout

    apply_theme(outline.get('theme'))
    slides_data = outline.get('slides', [])
    total = len(slides_data)

    for i, slide_data in enumerate(slides_data):
        layout = slide_data.get('layout', 'bullets')
        content = slide_data.get('content', {})

        if not content:
            continue

        slide = prs.slides.add_slide(blank_layout)
        renderer = RENDERERS.get(layout, render_bullets)
        renderer(slide, content, slide_idx=i + 1, total=total)

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
