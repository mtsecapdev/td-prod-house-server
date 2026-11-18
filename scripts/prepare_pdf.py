"""
Prepares a PDF for docling. Interactive training PDFs often put their illustrations in media annotations
(Screen, RichMedia, Movie): viewers draw the poster image, but it is not page content, so docling sees an empty
space under the caption. This bakes those annotations (and stamps, which are usually images) into the page.
Other annotations (comments, highlights) and form widgets are dropped from the copy, not drawn.

Usage: prepare_pdf.py <input.pdf> <output.pdf>
Prints JSON: {"baked": <number of annotations drawn into pages>}; output is written only when baked > 0.
"""
import json
import sys

import pymupdf

PICTURE_ANNOTS = {'Screen', 'RichMedia', 'Movie', 'Stamp', '3D'}


def main():
    src, dst = sys.argv[1], sys.argv[2]
    doc = pymupdf.open(src)
    baked = 0
    for page in doc:
        for annot in list(page.annots() or []):
            if annot.type[1] in PICTURE_ANNOTS:
                baked += 1
            else:
                page.delete_annot(annot)
    if baked:
        doc.bake(annots=True, widgets=False)
        doc.save(dst, garbage=3, deflate=True)
    print(json.dumps({'baked': baked}))


if __name__ == '__main__':
    main()
