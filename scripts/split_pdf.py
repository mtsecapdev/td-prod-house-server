"""Split a large PDF into smaller chunks of N pages each.

Usage: python split_pdf.py <input.pdf> <output_dir> [pages_per_chunk]

Writes chunk_001.pdf, chunk_002.pdf, ... to output_dir.
Prints JSON to stdout: { "chunks": ["chunk_001.pdf", ...], "total_pages": N }
"""

import sys
import os
import json
import fitz  # pymupdf

def split_pdf(input_path, output_dir, pages_per_chunk=25):
    doc = fitz.open(input_path)
    total_pages = len(doc)

    os.makedirs(output_dir, exist_ok=True)

    chunk_files = []
    for start in range(0, total_pages, pages_per_chunk):
        end = min(start + pages_per_chunk, total_pages)
        chunk_doc = fitz.open()
        chunk_doc.insert_pdf(doc, from_page=start, to_page=end - 1)

        chunk_name = f"chunk_{start // pages_per_chunk + 1:03d}.pdf"
        chunk_path = os.path.join(output_dir, chunk_name)
        chunk_doc.save(chunk_path)
        chunk_doc.close()
        chunk_files.append(chunk_name)

    doc.close()

    result = {"chunks": chunk_files, "total_pages": total_pages}
    print(json.dumps(result))

if __name__ == "__main__":
    input_path = sys.argv[1]
    output_dir = sys.argv[2]
    pages_per_chunk = int(sys.argv[3]) if len(sys.argv) > 3 else 25
    split_pdf(input_path, output_dir, pages_per_chunk)
