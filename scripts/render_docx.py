"""
Render a training document generation JSON into a .docx file using python-docx.

Usage:
    python render_docx.py <input.json> <output.docx> [template.docx]

Input JSON shape (the generation's outline object):
    { "sections": [ { "section_type": "heading|body|...", "content": { ... } }, ... ] }
"""

import json
import sys
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


def style_run(run, size=11, bold=False, color=DARK, font_name='Calibri'):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font_name


def add_heading_styled(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    for run in p.runs:
        run.font.color.rgb = NAVY
        run.font.name = 'Calibri'
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
    style_run(run, size=28, bold=True, color=NAVY)
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

    for section_data in outline.get('sections', []):
        section_type = section_data.get('section_type', 'body')
        content = section_data.get('content', {})

        if not content:
            continue

        renderer = RENDERERS.get(section_type, render_body)
        renderer(doc, content)

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
