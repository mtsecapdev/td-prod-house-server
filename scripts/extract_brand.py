"""
Read a company .pptx template's theme (colour scheme and fonts) and map it onto the app's template tokens
(see templates/themes.json).

Usage:
    python extract_brand.py <template.pptx>

Prints JSON: {"colors": {...tokens...}, "fonts": {"heading": ..., "body": ...}, "slide_size": [w, h]}
"""

import json
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/package/2006/relationships',
}
SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']


def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(rgb):
    return '#' + ''.join(f'{max(0, min(255, round(c))):02X}' for c in rgb)


def mix(a, b, t):
    """Blend colour a toward b by t (0..1)."""
    ra, rb = hex_to_rgb(a), hex_to_rgb(b)
    return rgb_to_hex(tuple(x + (y - x) * t for x, y in zip(ra, rb)))


def distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(hex_to_rgb(a), hex_to_rgb(b))) ** 0.5


def luminance(h):
    r, g, b = (c / 255 for c in hex_to_rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def theme_path(z):
    """The theme used by the first slide master (falls back to theme1)."""
    try:
        rels = ET.fromstring(z.read('ppt/slideMasters/_rels/slideMaster1.xml.rels'))
        for rel in rels:
            if rel.get('Type', '').endswith('/theme'):
                return posixpath.normpath(posixpath.join('ppt/slideMasters', rel.get('Target')))
    except KeyError:
        pass
    return 'ppt/theme/theme1.xml'


def read_theme(path):
    with zipfile.ZipFile(path) as z:
        theme = ET.fromstring(z.read(theme_path(z)))
        pres = ET.fromstring(z.read('ppt/presentation.xml'))
    scheme = theme.find('.//a:clrScheme', NS)
    colors = {}
    for slot in SLOTS:
        node = scheme.find(f'a:{slot}', NS) if scheme is not None else None
        if node is None:
            continue
        srgb = node.find('a:srgbClr', NS)
        sys_clr = node.find('a:sysClr', NS)
        if srgb is not None:
            colors[slot] = '#' + srgb.get('val').upper()
        elif sys_clr is not None and sys_clr.get('lastClr'):
            colors[slot] = '#' + sys_clr.get('lastClr').upper()
    major = theme.find('.//a:fontScheme/a:majorFont/a:latin', NS)
    minor = theme.find('.//a:fontScheme/a:minorFont/a:latin', NS)
    size = pres.find('p:sldSz', NS)
    return {
        'scheme': colors,
        'heading': (major.get('typeface') if major is not None else '') or 'Calibri',
        'body': (minor.get('typeface') if minor is not None else '') or 'Calibri',
        'slide_size': [int(size.get('cx')), int(size.get('cy'))] if size is not None else None,
    }


def to_tokens(scheme):
    """Map a PowerPoint colour scheme onto the app's tokens. Our layouts need a light surface and a dark brand
    colour, so dark themes fall back to white surfaces and the darkest scheme colour."""
    dk1 = scheme.get('dk1', '#000000')
    lt1 = scheme.get('lt1', '#FFFFFF')
    surface = lt1 if luminance(lt1) > 0.85 else '#FFFFFF'
    text_base = dk1 if luminance(dk1) < 0.35 else '#1E293B'

    candidates = [scheme.get(k) for k in ('dk2', 'accent1', 'accent2', 'dk1') if scheme.get(k)]
    primary = next((c for c in candidates if luminance(c) < 0.3), mix(scheme.get('accent1', '#0F2B48'), '#000000', 0.45))
    accents = [scheme.get(f'accent{i}') for i in range(1, 7) if scheme.get(f'accent{i}')]
    # The first accent that stands apart from the primary colour and is not near-white.
    accent = next((c for c in accents if distance(c, primary) > 60 and luminance(c) < 0.8),
                  mix(primary, '#FFFFFF', 0.35))

    return {
        'primary': primary,
        'primary_mid': mix(primary, '#FFFFFF', 0.08),
        'primary_light': mix(primary, '#FFFFFF', 0.18),
        'accent': accent,
        'accent_light': mix(accent, '#FFFFFF', 0.45),
        'text': mix(text_base, surface, 0.2),
        'text_light': mix(text_base, surface, 0.55),
        'border': mix(surface, text_base, 0.12),
        'canvas': mix(surface, accent, 0.05),
        'surface': surface,
        'positive': '#10B981',
        'warning': '#F59E0B',
    }


def main():
    if len(sys.argv) != 2:
        print('Usage: extract_brand.py <template.pptx>', file=sys.stderr)
        sys.exit(1)
    theme = read_theme(sys.argv[1])
    print(json.dumps({
        'colors': to_tokens(theme['scheme']),
        'fonts': {'heading': theme['heading'], 'body': theme['body']},
        'scheme': theme['scheme'],
        'slide_size': theme['slide_size'],
    }))


if __name__ == '__main__':
    main()
