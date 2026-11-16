"""Render diagram (Mermaid) or infographic (HTML template) to PNG via Playwright."""

import base64
import html
import json
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader
from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = SCRIPT_DIR / "templates"
VENDOR_DIR = SCRIPT_DIR / "vendor"
MERMAID_JS = VENDOR_DIR / "mermaid.min.js"
FONT_FILE = VENDOR_DIR / "fonts" / "inter-latin-wght.woff2"

FONT_FAMILY = "Inter"


def font_face_css() -> str:
    # Embedded as a data URI: pages loaded via set_content can't reliably fetch file:// URLs.
    data = base64.b64encode(FONT_FILE.read_bytes()).decode("ascii")
    return (
        f"@font-face {{ font-family: '{FONT_FAMILY}'; font-style: normal; "
        f"font-weight: 100 900; font-display: block; "
        f"src: url(data:font/woff2;base64,{data}) format('woff2'); }}"
    )


def load_font(page) -> None:
    page.add_style_tag(content=font_face_css())
    # Wait until the font is actually usable so text is measured and painted with it.
    page.evaluate(
        """async (family) => {
            await Promise.all([400, 600, 700].map(w => document.fonts.load(`${w} 16px "${family}"`)));
            await document.fonts.ready;
        }""",
        FONT_FAMILY,
    )


def screenshot_body(page, output_path: str) -> None:
    page.query_selector("body").screenshot(path=output_path)


def render_diagram(content: dict, output_path: str) -> None:
    # Escape both: the LLM output routinely contains <, >, & (e.g. "-->").
    # Mermaid reads the <pre>'s textContent, so entities decode back to the original code.
    mermaid_code = html.escape(content["mermaid_code"])
    title = html.escape(content.get("title", ""))

    page_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ margin: 0; padding: 40px; background: #fff; font-family: '{FONT_FAMILY}', sans-serif; }}
  h1 {{ color: #0F2B48; font-size: 28px; margin: 0 0 24px 0; text-align: center; }}
  #diagram {{ display: flex; justify-content: center; }}
</style>
</head><body>
  <h1>{title}</h1>
  <div id="diagram"><pre class="mermaid">{mermaid_code}</pre></div>
</body></html>"""

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=2)
        page.set_content(page_html)
        load_font(page)  # before Mermaid, which measures text to size its nodes
        page.add_script_tag(path=str(MERMAID_JS))
        page.evaluate(
            """async (family) => {
                mermaid.initialize({ startOnLoad: false, theme: 'default', fontFamily: family });
                await mermaid.run({ querySelector: '.mermaid' });
            }""",
            FONT_FAMILY,
        )
        screenshot_body(page, output_path)
        browser.close()


def render_template(fmt: str, content: dict, output_path: str) -> None:
    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    template = env.get_template(f"{fmt}.html")
    page_html = template.render(**content)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=2)
        page.set_content(page_html, wait_until="networkidle")
        load_font(page)
        screenshot_body(page, output_path)
        browser.close()


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.json> <output.png>", file=sys.stderr)
        sys.exit(1)

    input_path, output_path = sys.argv[1], sys.argv[2]

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    fmt = data["format"]
    content = data["content"]

    if fmt == "diagram":
        render_diagram(content, output_path)
    elif fmt in ("process", "comparison", "key_stats", "timeline"):
        render_template(fmt, content, output_path)
    else:
        print(f"Unknown format: {fmt}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
