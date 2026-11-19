"""
Render a training document generation JSON into a .docx file using python-docx.

Usage:
    python render_docx.py <input.json> <output.docx> [template.docx]

Input JSON shape (the generation's outline object):
    { "sections": [ { "section_type": "heading|body|...", "content": { ... } }, ... ] }
"""

import json
import re
import struct
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.shared import Inches, Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT

NAVY = RGBColor(0x0F, 0x2B, 0x48)
COBALT = RGBColor(0x25, 0x63, 0xEB)
SLATE = RGBColor(0x47, 0x55, 0x69)
DARK = RGBColor(0x1E, 0x29, 0x3B)
BORDER_GRAY = RGBColor(0xE2, 0xE8, 0xF0)
FONT_HEADING = 'Calibri'
FONT_BODY = 'Calibri'


def hex_color(value):
    value = value.lstrip('#')
    return RGBColor(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def apply_theme(theme):
    """Swap colours and fonts for a template from templates/themes.json (read at call time by the renderers)."""
    global NAVY, COBALT, SLATE, BORDER_GRAY, FONT_HEADING, FONT_BODY
    if not theme:
        return
    c = theme['colors']
    NAVY, COBALT, SLATE = hex_color(c['primary']), hex_color(c['accent']), hex_color(c['text'])
    BORDER_GRAY = hex_color(c['border'])
    FONT_HEADING, FONT_BODY = theme['fonts']['heading'], theme['fonts']['body']


def style_run(run, size=11, bold=False, color=DARK, font_name=None):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font_name or FONT_BODY


def add_heading_styled(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    for run in p.runs:
        run.font.color.rgb = NAVY
        run.font.name = FONT_HEADING
    return p


def add_body_text(doc, text, size=11, bold=False, color=DARK):
    p = doc.add_paragraph()
    run = p.add_run(text or '')
    style_run(run, size=size, bold=bold, color=color)
    p.paragraph_format.space_after = Pt(6)
    return p


def add_spacer(doc, pts=12):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(pts)
    p.paragraph_format.space_after = Pt(0)


def render_heading(doc, content):
    add_spacer(doc, 24)

    p = doc.add_paragraph()
    run = p.add_run(content.get('title', ''))
    style_run(run, size=28, bold=True, color=NAVY, font_name=FONT_HEADING)
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    if content.get('subtitle'):
        p2 = doc.add_paragraph()
        run2 = p2.add_run(content['subtitle'])
        style_run(run2, size=14, color=SLATE)

    add_spacer(doc, 8)

    # Accent line
    p_line = doc.add_paragraph()
    run_line = p_line.add_run('_' * 40)
    style_run(run_line, size=8, color=COBALT)

    add_spacer(doc, 8)

    if content.get('summary'):
        add_body_text(doc, content['summary'], size=11, color=SLATE)

    add_spacer(doc, 16)


def render_body(doc, content):
    add_heading_styled(doc, content.get('title', ''), level=2)

    for para in content.get('paragraphs', []):
        if para.get('subheading'):
            p = doc.add_paragraph()
            run = p.add_run(para['subheading'])
            style_run(run, size=12, bold=True, color=NAVY)
            p.paragraph_format.space_before = Pt(8)

        if para.get('text'):
            add_body_text(doc, para['text'])

    if content.get('key_takeaway'):
        add_spacer(doc, 4)
        p = doc.add_paragraph()
        run_label = p.add_run('Key Takeaway: ')
        style_run(run_label, size=11, bold=True, color=COBALT)
        run_text = p.add_run(content['key_takeaway'])
        style_run(run_text, size=11, color=DARK)


def render_procedure(doc, content):
    add_heading_styled(doc, content.get('title', ''), level=2)

    if content.get('introduction'):
        add_body_text(doc, content['introduction'])

    for step in content.get('steps', []):
        p = doc.add_paragraph()
        num = step.get('step_number', '')
        run_num = p.add_run(f'Step {num}: ')
        style_run(run_num, size=11, bold=True, color=NAVY)
        run_action = p.add_run(step.get('action', ''))
        style_run(run_action, size=11, bold=True, color=DARK)
        p.paragraph_format.space_before = Pt(6)

        if step.get('detail'):
            add_body_text(doc, step['detail'])

        caution = step.get('caution', '')
        if caution:
            p_caution = doc.add_paragraph()
            run_c = p_caution.add_run(f'CAUTION: {caution}')
            style_run(run_c, size=10, bold=True, color=RGBColor(0xDC, 0x26, 0x26))
            p_caution.paragraph_format.left_indent = Cm(1)

    if content.get('notes'):
        add_spacer(doc, 4)
        add_body_text(doc, content['notes'], size=10, color=SLATE)


def render_key_points(doc, content):
    add_heading_styled(doc, content.get('title', ''), level=2)

    if content.get('introduction'):
        add_body_text(doc, content['introduction'])

    for point in content.get('points', []):
        p = doc.add_paragraph()
        run_label = p.add_run(f'{point.get("label", "")}: ')
        style_run(run_label, size=11, bold=True, color=COBALT)
        run_desc = p.add_run(point.get('description', ''))
        style_run(run_desc, size=11, color=DARK)
        p.paragraph_format.space_before = Pt(4)

    if content.get('notes'):
        add_spacer(doc, 4)
        add_body_text(doc, content['notes'], size=10, color=SLATE)


def render_reference_table(doc, content):
    add_heading_styled(doc, content.get('title', ''), level=2)

    if content.get('introduction'):
        add_body_text(doc, content['introduction'])

    columns = content.get('columns', [])
    rows = content.get('rows', [])

    if columns and rows:
        table = doc.add_table(rows=1 + len(rows), cols=len(columns))
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        table.style = 'Table Grid'

        # Header row
        for i, col in enumerate(columns):
            cell = table.rows[0].cells[i]
            cell.text = ''
            p = cell.paragraphs[0]
            run = p.add_run(col)
            style_run(run, size=10, bold=True, color=NAVY)

        # Data rows
        for r_idx, row in enumerate(rows):
            for c_idx, val in enumerate(row):
                if c_idx < len(columns):
                    cell = table.rows[r_idx + 1].cells[c_idx]
                    cell.text = ''
                    p = cell.paragraphs[0]
                    run = p.add_run(str(val))
                    style_run(run, size=10, color=DARK)

    if content.get('notes'):
        add_spacer(doc, 4)
        add_body_text(doc, content['notes'], size=10, color=SLATE)


def render_summary(doc, content):
    add_heading_styled(doc, content.get('title', ''), level=2)

    for point in content.get('recap_points', []):
        p = doc.add_paragraph(style='List Bullet')
        run = p.add_run(point)
        style_run(run, size=11, color=DARK)

    if content.get('next_steps'):
        add_spacer(doc, 8)
        p = doc.add_paragraph()
        run_label = p.add_run('Next Steps: ')
        style_run(run_label, size=12, bold=True, color=NAVY)
        p2 = doc.add_paragraph()
        run_text = p2.add_run(content['next_steps'])
        style_run(run_text, size=11, color=DARK)

    if content.get('notes'):
        add_spacer(doc, 4)
        add_body_text(doc, content['notes'], size=10, color=SLATE)


# Diagram PNGs are rendered at 3x (renderer RENDER_SCALE); 288 dpi keeps their natural on-screen size.
DIAGRAM_DPI = 288
FIGURE_MAX_W = Cm(16)
FIGURE_MAX_H = Cm(18)


def png_size(path):
    """(width, height) in pixels, read from the PNG header."""
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'Not a PNG: {path}')
    return struct.unpack('>II', head[16:24])


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


def cropped_copy(path, crop):
    """Word has no simple crop setting in python-docx, so the cropped image is written to a temporary PNG."""
    from PIL import Image
    l, t, r, b = crop
    with Image.open(path) as im:
        w, h = im.size
        box = (round(w * l), round(h * t), round(w * (1 - r)), round(h * (1 - b)))
        out = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        im.crop(box).save(out, 'PNG')
        out.close()
    return out.name


def render_diagram(doc, content, figure_no=1):
    add_heading_styled(doc, content.get('title', ''), level=2)

    if content.get('introduction'):
        add_body_text(doc, content['introduction'])

    path = content.get('diagram_path')
    if path and Path(path).exists():
        img = image_settings(content.get('image'))
        crop = img['crop']
        if any(crop):
            path = cropped_copy(path, crop)
        w_px, h_px = png_size(path)
        natural_w = Inches(w_px / DIAGRAM_DPI)
        natural_h = Inches(h_px / DIAGRAM_DPI)
        if img['w'] is not None:
            # The editor's width is a share of the text column; kept within the page height.
            width = min(FIGURE_MAX_W * min(img['w'], 1.0), FIGURE_MAX_H * natural_w / natural_h)
        else:
            width = natural_w * min(1.0, FIGURE_MAX_W / natural_w, FIGURE_MAX_H / natural_h)
        p = doc.add_paragraph()
        p.alignment = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'right': WD_ALIGN_PARAGRAPH.RIGHT}.get(img['align'], WD_ALIGN_PARAGRAPH.CENTER)
        p.add_run().add_picture(path, width=int(width))
        if any(crop):
            Path(path).unlink(missing_ok=True)
        p.paragraph_format.keep_with_next = True  # keep the caption on the same page as the figure
    else:
        add_body_text(doc, '[Diagram not available]', color=SLATE)

    caption = (content.get('caption') or '').strip()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run_label = p.add_run(f'Figure {figure_no}' + (': ' if caption else ''))
    style_run(run_label, size=10, bold=True, color=NAVY)
    if caption:
        run_cap = p.add_run(caption)
        style_run(run_cap, size=10, color=SLATE)
        run_cap.font.italic = True
    p.paragraph_format.space_after = Pt(10)

    if content.get('notes'):
        add_spacer(doc, 4)
        add_body_text(doc, content['notes'], size=10, color=SLATE)


def render_picture(doc, pic, figure_no):
    """A picture placed from the documents, sized/aligned/cropped as in the editor, with its numbered caption."""
    img = image_settings(pic)
    path = pic.get('path')
    if path and Path(path).exists():
        crop = img['crop']
        if any(crop):
            path = cropped_copy(path, crop)
        w_px, h_px = png_size(path)
        natural_w, natural_h = Inches(w_px / DIAGRAM_DPI), Inches(h_px / DIAGRAM_DPI)
        if img['w'] is not None:
            width = min(FIGURE_MAX_W * min(img['w'], 1.0), FIGURE_MAX_H * natural_w / natural_h)
        else:
            width = natural_w * min(1.0, FIGURE_MAX_W / natural_w, FIGURE_MAX_H / natural_h)
        p = doc.add_paragraph()
        p.alignment = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'right': WD_ALIGN_PARAGRAPH.RIGHT}.get(img['align'], WD_ALIGN_PARAGRAPH.CENTER)
        p.add_run().add_picture(path, width=int(width))
        p.paragraph_format.keep_with_next = True  # keep the caption on the same page as the figure
        if any(crop):
            Path(path).unlink(missing_ok=True)
    else:
        add_body_text(doc, '[Image removed]' if pic.get('image_id') else '[Figure removed]', color=SLATE)

    # The document numbers its own figures, so the source's number ("Figure 2.2-1 ...") is dropped here.
    caption = re.sub(r'^fig(?:ure)?\.?\s*[A-Z]?\d+(?:[.\-]\d+)*[a-z]?\s*[-–—:.]*\s*', '', (pic.get('caption') or '').strip(), flags=re.I)
    p = doc.add_paragraph()
    p.alignment = {'left': WD_ALIGN_PARAGRAPH.LEFT, 'right': WD_ALIGN_PARAGRAPH.RIGHT}.get(img['align'], WD_ALIGN_PARAGRAPH.CENTER)
    run_label = p.add_run(f'Figure {figure_no}' + (': ' if caption else ''))
    style_run(run_label, size=10, bold=True, color=NAVY)
    if caption:
        run_cap = p.add_run(caption)
        style_run(run_cap, size=10, color=SLATE)
        run_cap.font.italic = True
    p.paragraph_format.space_after = Pt(10)


def render_figure_section(doc, content):
    """A section built around a figure: title and introduction; its pictures follow, then the notes."""
    add_heading_styled(doc, content.get('title', ''), level=2)
    if content.get('introduction'):
        add_body_text(doc, content['introduction'])


RENDERERS = {
    'heading': render_heading,
    'body': render_body,
    'procedure': render_procedure,
    'key_points': render_key_points,
    'reference_table': render_reference_table,
    'summary': render_summary,
}


def render_doc(outline, output_path, template_path=None):
    if template_path and Path(template_path).exists():
        doc = Document(template_path)
    else:
        doc = Document()

    # Set default margins
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    apply_theme(outline.get('theme'))
    figure_no = 0
    for section_data in outline.get('sections', []):
        section_type = section_data.get('section_type', 'body')
        content = section_data.get('content', {})

        if not content:
            continue

        if section_type == 'diagram':
            figure_no += 1
            render_diagram(doc, content, figure_no)
        elif section_type == 'figure':
            render_figure_section(doc, content)
        else:
            RENDERERS.get(section_type, render_body)(doc, content)

        # Pictures placed on the section, numbered with the other figures.
        for pic in content.get('pictures') or []:
            figure_no += 1
            render_picture(doc, pic, figure_no)
        if section_type == 'figure' and content.get('notes'):
            add_spacer(doc, 4)
            add_body_text(doc, content['notes'], size=10, color=SLATE)

    doc.save(output_path)
    return output_path


def main():
    if len(sys.argv) < 3:
        print('Usage: render_docx.py <input.json> <output.docx> [template.docx]', file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    template_path = sys.argv[3] if len(sys.argv) > 3 else None

    with open(input_path, 'r', encoding='utf-8') as f:
        outline = json.load(f)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    render_doc(outline, output_path, template_path)
    print(json.dumps({'ok': True, 'path': output_path}))


if __name__ == '__main__':
    main()
