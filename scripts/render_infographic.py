"""Render diagram (Mermaid) or infographic (HTML template) to PNG via Playwright."""

import json
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader
from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = SCRIPT_DIR / "templates"
VENDOR_DIR = SCRIPT_DIR / "vendor"
MERMAID_JS = VENDOR_DIR / "mermaid.min.js"


def render_diagram(content: dict, output_path: str) -> None:
    mermaid_code = content["mermaid_code"]
    title = content.get("title", "")

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ margin: 0; padding: 40px; background: #fff; font-family: 'Segoe UI', sans-serif; }}
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
        page.set_content(html)
        page.add_script_tag(path=str(MERMAID_JS))
        page.evaluate("() => mermaid.initialize({ startOnLoad: true, theme: 'default' })")
        page.evaluate("() => mermaid.run()")
        page.wait_for_timeout(2000)

        body = page.query_selector("body")
        body.screenshot(path=output_path)
        browser.close()


def render_template(fmt: str, content: dict, output_path: str) -> None:
    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=True)
    template = env.get_template(f"{fmt}.html")
    html = template.render(**content)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=2)
        page.set_content(html, wait_until="networkidle")
        page.wait_for_timeout(500)

        body = page.query_selector("body")
        body.screenshot(path=output_path)
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
