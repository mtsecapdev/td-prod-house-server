"""
Render a slide deck into a .pptx file with python-pptx.

Usage:
    python render_pptx.py <input.json> <output.pptx> [template.pptx]

Input JSON (written by src/services/officeRenderer.js):
    { "slides": [ { "layout", "content", "background", "boxes": [...], "picture_boxes": [[x, y, w, h], ...] } ], "theme": {...} }

This script makes no design decisions. Where everything goes is worked out by the layout engine
(shared/slides/layout.js), which the editor's preview draws from too; each slide arrives as a list of boxes in
inches (shapes, texts, icons, a table, the diagram's area), and they are drawn here as editable PowerPoint
shapes, text boxes and real tables. Pictures the user placed (content.pictures) are drawn where the editor put
them, or fitted into their picture_boxes.
"""

import json
import struct
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn

SLIDE_WIDTH = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)
EMU_PER_INCH = 914400
ICONS = Path(__file__).parent.parent / 'shared' / 'icons'
CAPTION_PT = 11
CAPTION_H = 0.55

ALIGN = {'l': PP_ALIGN.LEFT, 'c': PP_ALIGN.CENTER, 'r': PP_ALIGN.RIGHT}
ANCHOR = {'t': MSO_ANCHOR.TOP, 'm': MSO_ANCHOR.MIDDLE, 'b': MSO_ANCHOR.BOTTOM}


# ── Theme: the colour and font names the layout engine uses ──

def hex_color(value):
    value = value.lstrip('#')
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def blend(color, other, t):
    """color moved t of the way towards other."""
    return RGBColor(*(round(a + (b - a) * t) for a, b in zip(color, other)))


DEFAULT_THEME = {
    'colors': {
        'primary': '#0F2B48', 'primary_mid': '#163A60', 'primary_light': '#1E4A7A', 'accent': '#2563EB',
        'accent_light': '#60A5FA', 'text': '#475569', 'text_light': '#94A3B8', 'border': '#E2E8F0',
        'canvas': '#F0F4F8', 'surface': '#FFFFFF',
    },
    'fonts': {'heading': 'Segoe UI', 'body': 'Segoe UI'},
}


class Theme:
    def __init__(self, theme):
        theme = theme or DEFAULT_THEME
        c = {**DEFAULT_THEME['colors'], **(theme.get('colors') or {})}
        white = RGBColor(0xFF, 0xFF, 0xFF)
        self.colors = {k: hex_color(v) for k, v in c.items() if isinstance(v, str) and v.startswith('#')}
        self.colors['white'] = white
        self.colors['on_dark'] = blend(white, self.colors['primary'], 0.25)
        self.colors['accent_tint'] = blend(self.colors['accent'], self.colors['surface'], 0.88)
        self.colors['quote_mark'] = blend(self.colors['accent'], white, 0.55)
        fonts = {**DEFAULT_THEME['fonts'], **(theme.get('fonts') or {})}
        self.fonts = {'heading': fonts['heading'], 'body': fonts['body'], 'quote': 'Georgia'}

    def color(self, name):
        return self.colors.get(name, self.colors['text'])


# ── Shapes ──

def inch(v):
    return int(Inches(v))


def _flat(shape):
    """No outline and none of the default shape style (its effects add a drop shadow)."""
    shape.line.fill.background()
    style = shape._element.find(qn('p:style'))
    if style is not None:
        shape._element.remove(style)
    return shape


def _alpha(shape, alpha):
    srgb = shape._element.find(qn('p:spPr')).find(qn('a:solidFill')).find(qn('a:srgbClr'))
    node = srgb.makeelement(qn('a:alpha'), {})
    node.set('val', str(int(alpha * 100000)))
    srgb.append(node)


def draw_shape(slide, box, theme, oval=False):
    radius = box.get('radius') or 0
    kind = MSO_SHAPE.OVAL if oval else (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE)
    shape = slide.shapes.add_shape(kind, inch(box['x']), inch(box['y']), inch(box['w']), inch(box['h']))
    _flat(shape)
    if radius:
        shape.adjustments[0] = min(0.5, radius / max(0.01, min(box['w'], box['h'])))
    if box.get('fill', 'none') == 'none':
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = theme.color(box['fill'])
        if box.get('alpha') is not None:
            _alpha(shape, box['alpha'])
    if box.get('outline'):
        shape.line.color.rgb = theme.color(box['outline'])
        shape.line.width = Pt(1)
    return shape


def draw_line(slide, box, theme):
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, inch(box['x1']), inch(box['y1']), inch(box['x2']), inch(box['y2']))
    line.line.color.rgb = theme.color(box.get('color', 'border'))
    line.line.width = Pt(box.get('weight', 1.5))


def draw_text(slide, box, theme, text=None):
    text = str((box.get('text') if text is None else text) or '')
    if not text.strip():
        return
    text = (box.get('prefix') or '') + text
    if box.get('caps'):
        text = text.upper()
    shape = slide.shapes.add_textbox(inch(box['x']), inch(box['y']), inch(box['w']), inch(box['h']))
    tf = shape.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = ANCHOR[box.get('anchor', 't')]
    size = box.get('size', 16)
    for k, part in enumerate(text.split('\n')):
        p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
        p.text = part
        p.alignment = ALIGN[box.get('align', 'l')]
        p.line_spacing = Pt(size * box.get('lh', 1.25))
        f = p.font
        f.size = Pt(size)
        f.bold = bool(box.get('bold'))
        f.italic = bool(box.get('italic'))
        f.name = theme.fonts.get(box.get('font', 'body'), theme.fonts['body'])
        f.color.rgb = theme.color(box.get('color', 'text'))


def draw_icon(slide, box, theme):
    """An accent circle holding the icon, or without one the point's number."""
    draw_shape(slide, box, theme, oval=True)
    name = box.get('name')
    path = ICONS / f'{name}.png' if name else None
    if path and path.exists():
        inset = box['w'] * 0.24
        slide.shapes.add_picture(str(path), inch(box['x'] + inset), inch(box['y'] + inset), inch(box['w'] - 2 * inset), inch(box['h'] - 2 * inset))
    elif box.get('number'):
        draw_text(slide, {**box, 'size': round(box['w'] * 72 * 0.38), 'bold': True, 'font': 'heading', 'color': 'white',
                          'align': 'c', 'anchor': 'm', 'lh': 1.0}, theme, str(box['number']))


def _cell_border(cell, edge, color=None):
    """One edge of a table cell: a thin line in `color`, or none."""
    tc_pr = cell._tc.get_or_add_tcPr()
    tag = {'top': 'a:lnT', 'bottom': 'a:lnB', 'left': 'a:lnL', 'right': 'a:lnR'}[edge]
    for old in tc_pr.findall(qn(tag)):
        tc_pr.remove(old)
    ln = tc_pr.makeelement(qn(tag), {'w': str(Pt(1) if color else 0), 'cmpd': 'sng'})
    if color:
        fill = ln.makeelement(qn('a:solidFill'), {})
        fill.append(fill.makeelement(qn('a:srgbClr'), {'val': str(color)}))
        ln.append(fill)
    else:
        ln.append(ln.makeelement(qn('a:noFill'), {}))
    tc_pr.append(ln)


def draw_table(slide, box, theme):
    """A real table: a header row in the primary colour, thin rules between rows, the first column in bold."""
    columns, rows = box['columns'], box['rows']
    shape = slide.shapes.add_table(len(rows) + 1, len(columns), inch(box['x']), inch(box['y']), inch(box['w']), inch(box['h']))
    table = shape.table
    style = shape._element.graphic.graphicData.tbl.tblPr.find(qn('a:tableStyleId'))
    if style is not None:
        style.text = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'  # "No Style, No Grid": our own colours only
    table.first_row = True
    table.horz_banding = False
    for k, w in enumerate(box['colW']):
        table.columns[k].width = inch(w)
    size = box['size']
    for r in range(len(rows) + 1):
        table.rows[r].height = inch(box['rowH'][r])
        for c in range(len(columns)):
            cell = table.cell(r, c)
            value = columns[c] if r == 0 else (rows[r - 1][c] if c < len(rows[r - 1]) else '')
            cell.fill.solid()
            cell.fill.fore_color.rgb = theme.color('primary' if r == 0 else 'surface')
            cell.margin_left = cell.margin_right = Inches(0.15)
            cell.margin_top = cell.margin_bottom = Inches(0.05)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.text_frame.word_wrap = True
            cell.text_frame.text = str(value or '')
            p = cell.text_frame.paragraphs[0]
            p.font.size = Pt(size - 1 if r == 0 else size)
            p.font.bold = r == 0 or c == 0
            p.font.name = theme.fonts['heading' if (r == 0 or c == 0) else 'body']
            p.font.color.rgb = theme.color('white' if r == 0 else ('primary' if c == 0 else 'text'))
            for edge in ('top', 'left', 'right'):
                _cell_border(cell, edge, None)
            _cell_border(cell, 'bottom', theme.color('border') if r else None)


# ── Pictures ──

def png_size(path):
    """(width, height) in pixels, read from the PNG header."""
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Not a PNG: {path}')
    return struct.unpack('>II', head[16:24])


def image_settings(a):
    """The user's picture settings from the editor, clamped so a bad save can never hide the picture: x, y, w as
    fractions of the slide (None = fit the default box), and crop fractions (l, t, r, b) per edge."""
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
    return {'x': num('x', -1.0, 1.0), 'y': num('y', -1.0, 1.0), 'w': num('w', 0.02, 1.5), 'crop': (l, t, r, b)}


def place_picture(slide, path, settings, box):
    """A picture where the user put it, else as large as fits in box (fractions of the slide), centred.
    Returns (left, top, width, height) in EMU. Cropping uses PowerPoint's own, so it stays adjustable."""
    l, t, r, b = settings['crop']
    if path:
        w_px, h_px = png_size(path)
        aspect = (h_px * (1 - t - b)) / (w_px * (1 - l - r))
    else:
        aspect = 0.6
    if None not in (settings['x'], settings['y'], settings['w']):
        left, top, width = int(SLIDE_WIDTH * settings['x']), int(SLIDE_HEIGHT * settings['y']), int(SLIDE_WIDTH * settings['w'])
        height = int(width * aspect)
    else:
        bx, by, bw, bh = box
        box_w, box_h = SLIDE_WIDTH * bw, SLIDE_HEIGHT * bh
        width = int(min(box_w, box_h / aspect))
        height = int(width * aspect)
        left = int(SLIDE_WIDTH * bx + (box_w - width) / 2)
        top = int(SLIDE_HEIGHT * by + (box_h - height) / 2)
    if path:
        pic = slide.shapes.add_picture(path, left, top, width, height)
        if any(settings['crop']):
            pic.crop_left, pic.crop_top, pic.crop_right, pic.crop_bottom = settings['crop']
    return left, top, width, height


def draw_pictures(slide, content, boxes, theme):
    """Pictures placed on the slide, each with its caption under it."""
    for pic, box in zip(content.get('pictures') or [], boxes):
        path = pic.get('path')
        exists = bool(path) and Path(path).exists()
        left, top, width, height = [v / EMU_PER_INCH for v in place_picture(slide, path if exists else None, image_settings(pic), box)]
        if not exists:
            draw_text(slide, {'x': left, 'y': top, 'w': width, 'h': height, 'size': 16, 'color': 'text_light', 'align': 'c', 'anchor': 'm'},
                      theme, 'Figure removed')
        caption = (pic.get('caption') or '').strip()
        if caption:
            cap_w = max(width, 3.2)
            draw_text(slide, {'x': left + (width - cap_w) / 2, 'y': top + height + 0.08, 'w': cap_w, 'h': CAPTION_H,
                              'size': CAPTION_PT, 'align': 'c', 'lh': 1.25}, theme, caption)


def draw_diagram(slide, box, content, theme):
    path = content.get('diagram_path')
    if path and Path(path).exists():
        area = (box['x'] / 13.333, box['y'] / 7.5, box['w'] / 13.333, box['h'] / 7.5)
        place_picture(slide, path, image_settings(content.get('image')), area)
    else:
        draw_text(slide, {**box, 'size': 16, 'color': 'text_light', 'align': 'c', 'anchor': 'm'}, theme, 'Diagram not available')


# ── Deck ──

DRAW = {
    'rect': lambda slide, box, theme, content: draw_shape(slide, box, theme),
    'oval': lambda slide, box, theme, content: draw_shape(slide, box, theme, oval=True),
    'line': lambda slide, box, theme, content: draw_line(slide, box, theme),
    'text': lambda slide, box, theme, content: draw_text(slide, box, theme),
    'icon': lambda slide, box, theme, content: draw_icon(slide, box, theme),
    'table': lambda slide, box, theme, content: draw_table(slide, box, theme),
    'image': lambda slide, box, theme, content: draw_diagram(slide, box, content, theme),
}


def draw_slide(slide, data, theme):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = theme.color(data.get('background', 'surface'))
    content = data.get('content') or {}
    for box in data.get('boxes', []):
        if not box.get('editOnly'):
            DRAW[box['type']](slide, box, theme, content)
    draw_pictures(slide, content, data.get('picture_boxes') or [], theme)
    notes = content.get('speaker_notes', '')
    if notes:
        slide.notes_slide.notes_text_frame.text = notes


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


def render_deck(deck, output_path, template_path=None):
    if template_path and Path(template_path).exists():
        prs = Presentation(template_path)
        remove_existing_slides(prs)
    else:
        prs = Presentation()
    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT
    blank = blank_layout_of(prs)
    theme = Theme(deck.get('theme'))
    for data in deck.get('slides', []):
        if data.get('content'):
            draw_slide(prs.slides.add_slide(blank), data, theme)
    prs.save(output_path)
    return output_path


def main():
    if len(sys.argv) < 3:
        print('Usage: render_pptx.py <input.json> <output.pptx> [template.pptx]', file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        deck = json.load(f)
    Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)
    render_deck(deck, sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(json.dumps({'ok': True, 'path': sys.argv[2]}))


if __name__ == '__main__':
    main()
