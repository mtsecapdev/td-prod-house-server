"""
Render a slide deck generation JSON into a .pptx file using python-pptx.

Usage:
    python render_pptx.py <input.json> <output.pptx> [template.pptx]

Input JSON shape (the generation's outline object):
    { "slides": [ { "layout": "title|bullets|...", "content": { ... } }, ... ] }
"""

import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

NAVY = RGBColor(0x0F, 0x2B, 0x48)
COBALT = RGBColor(0x25, 0x63, 0xEB)
SLATE = RGBColor(0x47, 0x55, 0x69)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
LIGHT_BG = RGBColor(0xF0, 0xF4, 0xF8)

SLIDE_WIDTH = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)


def set_slide_bg(slide, color):
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = color


def add_textbox(slide, left, top, width, height, text, font_size=18,
                bold=False, color=NAVY, alignment=PP_ALIGN.LEFT, font_name='Calibri'):
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text or ''
    p.font.size = Pt(font_size)
    p.font.bold = bold
    p.font.color.rgb = color
    p.font.name = font_name
    p.alignment = alignment
    return txBox


def add_shape_rect(slide, left, top, width, height, fill_color):
    from pptx.enum.shapes import MSO_SHAPE
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    shape.line.fill.background()
    return shape


def add_shape_oval(slide, left, top, width, height, fill_color, transparency=0):
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.oxml.ns import qn
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


def render_title(slide, content):
    set_slide_bg(slide, NAVY)

    # Accent bar at bottom
    add_shape_rect(slide, Inches(0), SLIDE_HEIGHT - Inches(0.08),
                   SLIDE_WIDTH, Inches(0.08), COBALT)

    # Title
    add_textbox(slide, Inches(1.5), Inches(2.2), Inches(10), Inches(2),
                content.get('title', ''), font_size=44, bold=True, color=WHITE)

    # Divider line
    add_shape_rect(slide, Inches(1.5), Inches(4.4), Inches(1), Inches(0.06), COBALT)

    # Subtitle
    add_textbox(slide, Inches(1.5), Inches(4.7), Inches(8), Inches(1.5),
                content.get('subtitle', ''), font_size=20, color=RGBColor(0x94, 0xA3, 0xB8))


def render_bullets(slide, content):
    set_slide_bg(slide, WHITE)

    # Cobalt accent bar on left
    add_shape_rect(slide, Inches(0), Inches(0), Inches(0.08), SLIDE_HEIGHT, COBALT)

    # Title
    add_textbox(slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                content.get('title', ''), font_size=32, bold=True, color=NAVY)

    # Separator
    add_shape_rect(slide, Inches(0.8), Inches(1.4), Inches(11.5), Inches(0.03),
                   RGBColor(0xE2, 0xE8, 0xF0))

    bullets = content.get('bullets', [])
    num_bullets = len(bullets)
    available = 5.5
    per_bullet = min(available / max(num_bullets, 1), 1.2)

    y = Inches(1.7)
    for i, bullet in enumerate(bullets):
        heading = bullet.get('heading', '')
        detail = bullet.get('detail', '')

        # Number badge
        badge = add_textbox(slide, Inches(0.8), y, Inches(0.5), Inches(0.5),
                            str(i + 1), font_size=14, bold=True, color=COBALT,
                            alignment=PP_ALIGN.CENTER)

        # Heading
        add_textbox(slide, Inches(1.5), y, Inches(10), Inches(0.35),
                    heading, font_size=16, bold=True, color=NAVY)

        # Detail
        detail_h = Inches(max(per_bullet - 0.45, 0.4))
        add_textbox(slide, Inches(1.5), y + Inches(0.35), Inches(10), detail_h,
                    detail, font_size=13, color=SLATE)

        y += Inches(per_bullet)

    _add_notes(slide, content)


def render_two_column(slide, content):
    set_slide_bg(slide, WHITE)

    # Title
    add_textbox(slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                content.get('title', ''), font_size=32, bold=True, color=NAVY)

    add_shape_rect(slide, Inches(0.8), Inches(1.4), Inches(11.5), Inches(0.03),
                   RGBColor(0xE2, 0xE8, 0xF0))

    col_width = Inches(5.2)
    left_x = Inches(0.8)
    right_x = Inches(7)

    # Column A heading
    add_shape_rect(slide, left_x, Inches(1.7), Inches(0.06), Inches(0.4), COBALT)
    add_textbox(slide, left_x + Inches(0.2), Inches(1.7), col_width, Inches(0.4),
                content.get('column_a_heading', ''), font_size=18, bold=True, color=NAVY)

    # Column A bullets
    a_bullets = content.get('column_a_bullets', [])
    b_bullets = content.get('column_b_bullets', [])
    max_bullets = max(len(a_bullets), len(b_bullets), 1)
    available_h = 4.8
    per_item = min(available_h / max_bullets, 1.2)

    y = Inches(2.3)
    for b in a_bullets:
        add_textbox(slide, left_x + Inches(0.2), y, col_width, Inches(max(per_item - 0.1, 0.5)),
                    f'• {b}', font_size=13, color=SLATE)
        y += Inches(per_item)

    # Column B heading
    add_shape_rect(slide, right_x, Inches(1.7), Inches(0.06), Inches(0.4),
                   RGBColor(0x10, 0xB9, 0x81))
    add_textbox(slide, right_x + Inches(0.2), Inches(1.7), col_width, Inches(0.4),
                content.get('column_b_heading', ''), font_size=18, bold=True, color=NAVY)

    # Column B bullets
    y = Inches(2.3)
    for b in b_bullets:
        add_textbox(slide, right_x + Inches(0.2), y, col_width, Inches(max(per_item - 0.1, 0.5)),
                    f'• {b}', font_size=13, color=SLATE)
        y += Inches(per_item)

    # Center divider
    add_shape_rect(slide, Inches(6.5), Inches(1.7), Inches(0.03), Inches(5),
                   RGBColor(0xE2, 0xE8, 0xF0))

    _add_notes(slide, content)


def render_stat_focus(slide, content):
    set_slide_bg(slide, WHITE)

    # Decorative circles (behind content)
    add_shape_oval(slide, SLIDE_WIDTH - Inches(2.5), Inches(-1.2),
                   Inches(4), Inches(4),
                   RGBColor(0x25, 0x63, 0xEB), transparency=0.92)
    add_shape_oval(slide, Inches(-1.2), SLIDE_HEIGHT - Inches(2.8),
                   Inches(3.2), Inches(3.2),
                   RGBColor(0x0F, 0x2B, 0x48), transparency=0.92)

    # Title at top
    add_textbox(slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                content.get('title', ''), font_size=28, bold=True, color=NAVY)

    # Divider under title
    add_shape_rect(slide, Inches(0.8), Inches(1.3), Inches(0.06), Inches(0.5), COBALT)

    # Big stat centered
    add_textbox(slide, Inches(1), Inches(2.2), Inches(11), Inches(1.8),
                content.get('stat_value', ''), font_size=72, bold=True, color=COBALT,
                alignment=PP_ALIGN.CENTER)

    # Small divider under stat
    add_shape_rect(slide, Inches(6.2), Inches(4.0), Inches(0.8), Inches(0.04), COBALT)

    # Label
    add_textbox(slide, Inches(1), Inches(4.2), Inches(11), Inches(0.6),
                (content.get('stat_label', '') or '').upper(), font_size=16, bold=True,
                color=SLATE, alignment=PP_ALIGN.CENTER)

    # Context
    add_textbox(slide, Inches(2), Inches(4.9), Inches(9), Inches(1.2),
                content.get('context', ''), font_size=16, color=SLATE,
                alignment=PP_ALIGN.CENTER)

    _add_notes(slide, content)


def render_quote_highlight(slide, content):
    set_slide_bg(slide, WHITE)

    # Title
    add_textbox(slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                content.get('title', ''), font_size=28, bold=True, color=NAVY)

    # Cobalt left border for quote area
    add_shape_rect(slide, Inches(1.5), Inches(1.8), Inches(0.08), Inches(3), COBALT)

    # Decorative quote mark
    add_textbox(slide, Inches(1.8), Inches(1.5), Inches(1), Inches(1),
                '“', font_size=72, bold=True, color=RGBColor(0x25, 0x63, 0xEB))

    # Quote text
    add_textbox(slide, Inches(2), Inches(2.2), Inches(9), Inches(2),
                content.get('quote_text', ''), font_size=22, color=NAVY)

    # Attribution
    add_textbox(slide, Inches(2), Inches(4.5), Inches(9), Inches(0.5),
                f'— {content.get("attribution", "")}', font_size=14,
                bold=True, color=SLATE)

    # Commentary
    add_textbox(slide, Inches(2), Inches(5.2), Inches(9), Inches(1),
                content.get('commentary', ''), font_size=14, color=SLATE)

    _add_notes(slide, content)


def render_checklist(slide, content):
    set_slide_bg(slide, WHITE)

    # Accent bar
    add_shape_rect(slide, Inches(0), Inches(0), Inches(0.08), SLIDE_HEIGHT, NAVY)

    # Title
    add_textbox(slide, Inches(0.8), Inches(0.5), Inches(11), Inches(0.8),
                content.get('title', ''), font_size=32, bold=True, color=NAVY)

    add_shape_rect(slide, Inches(0.8), Inches(1.4), Inches(11.5), Inches(0.03),
                   RGBColor(0xE2, 0xE8, 0xF0))

    items = content.get('items', [])
    num_items = len(items)
    available = 5.5
    per_item = min(available / max(num_items, 1), 1.2)

    y = Inches(1.7)
    for i, item in enumerate(items):
        # Number badge
        badge_shape = add_shape_rect(slide, Inches(0.8), y, Inches(0.4), Inches(0.4), NAVY)
        add_textbox(slide, Inches(0.8), y + Inches(0.02), Inches(0.4), Inches(0.35),
                    str(i + 1), font_size=13, bold=True, color=WHITE,
                    alignment=PP_ALIGN.CENTER)

        # Step name
        add_textbox(slide, Inches(1.5), y, Inches(10), Inches(0.35),
                    item.get('step', ''), font_size=15, bold=True, color=NAVY)

        # Detail
        detail_h = Inches(max(per_item - 0.45, 0.4))
        add_textbox(slide, Inches(1.5), y + Inches(0.35), Inches(10), detail_h,
                    item.get('detail', ''), font_size=12, color=SLATE)

        y += Inches(per_item)

    _add_notes(slide, content)


def _add_notes(slide, content):
    notes = content.get('speaker_notes', '')
    if notes:
        notes_slide = slide.notes_slide
        notes_slide.notes_text_frame.text = notes


RENDERERS = {
    'title': render_title,
    'bullets': render_bullets,
    'two_column': render_two_column,
    'stat_focus': render_stat_focus,
    'quote_highlight': render_quote_highlight,
    'checklist': render_checklist,
}


def render_deck(outline, output_path, template_path=None):
    if template_path and Path(template_path).exists():
        prs = Presentation(template_path)
    else:
        prs = Presentation()

    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT

    blank_layout = prs.slide_layouts[6]  # blank layout

    for slide_data in outline.get('slides', []):
        layout = slide_data.get('layout', 'bullets')
        content = slide_data.get('content', {})

        if not content:
            continue

        slide = prs.slides.add_slide(blank_layout)
        renderer = RENDERERS.get(layout, render_bullets)
        renderer(slide, content)

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
