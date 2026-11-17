"""Diagram render service: Mermaid code in, PNG out.

One Chromium stays running with a pool of pages that already have Mermaid and the Inter font loaded,
so a render costs a page.evaluate and a screenshot instead of a browser launch. The pool size caps how
many renders run at once; extra requests wait for a free page.

  POST /render/mermaid   {"code": "..."}  -> 200 image/png
                                           -> 422 {"error": "<Mermaid parse error>"} for invalid code
  GET  /health                             -> 200 {"ok": true}
"""

import asyncio
import base64
import json
import logging
import os
from pathlib import Path

from aiohttp import web
from playwright.async_api import async_playwright

POOL_SIZE = int(os.environ.get("RENDER_POOL_SIZE", "4"))
RENDER_TIMEOUT_S = float(os.environ.get("RENDER_TIMEOUT_S", "20"))
MAX_CODE_CHARS = 20_000
VENDOR = Path(os.environ.get("VENDOR_DIR", Path(__file__).resolve().parent / "vendor"))

log = logging.getLogger("renderer")

# Matches the deck and document palette (render_pptx.py / render_docx.py).
THEME = {
    "fontFamily": "Inter, sans-serif",
    "fontSize": "16px",
    "primaryColor": "#EAF0F8",
    "primaryBorderColor": "#2563EB",
    "primaryTextColor": "#0F2B48",
    "secondaryColor": "#F0F4F8",
    "tertiaryColor": "#FFFFFF",
    "lineColor": "#475569",
    "textColor": "#1E293B",
    "mainBkg": "#EAF0F8",
    "nodeBorder": "#2563EB",
    "clusterBkg": "#F8FAFC",
    "clusterBorder": "#CBD5E1",
    "edgeLabelBackground": "#FFFFFF",
    "actorBkg": "#EAF0F8",
    "actorBorder": "#2563EB",
    "actorTextColor": "#0F2B48",
    "noteBkgColor": "#FEF3C7",
    "noteBorderColor": "#F59E0B",
}


def page_html() -> str:
    font = base64.b64encode((VENDOR / "fonts" / "inter-latin-wght.woff2").read_bytes()).decode()
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: 'Inter'; font-weight: 100 900; src: url(data:font/woff2;base64,{font}) format('woff2'); }}
html, body {{ margin: 0; background: #fff; font-family: 'Inter', sans-serif; }}
#out {{ display: inline-block; padding: 24px; background: #fff; }}
#out svg {{ display: block; max-width: none !important; }}
</style></head><body><div id="out"></div></body></html>"""


RENDER_JS = """async (code) => {
  const out = document.getElementById('out');
  out.innerHTML = '';
  try {
    await mermaid.parse(code);
  } catch (e) {
    return { error: String((e && (e.str || e.message)) || e) };
  }
  window.__n = (window.__n || 0) + 1;
  const { svg } = await mermaid.render('d' + window.__n, code);
  out.innerHTML = svg;
  return { ok: true };
}"""


class Pool:
    def __init__(self):
        self.pages: asyncio.Queue = asyncio.Queue()
        self.html = page_html()

    async def start(self):
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(args=["--no-sandbox"])
        for _ in range(POOL_SIZE):
            await self.pages.put(await self.new_page())
        log.info("renderer ready with %d pages", POOL_SIZE)

    async def new_page(self):
        page = await self.browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        await page.set_content(self.html)
        await page.add_script_tag(path=str(VENDOR / "mermaid.min.js"))
        await page.evaluate("() => document.fonts.load('16px Inter')")
        await page.evaluate(
            "(t) => mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', "
            "themeVariables: t, flowchart: { htmlLabels: true, curve: 'basis' } })",
            THEME,
        )
        return page

    async def render(self, code: str):
        page = await self.pages.get()
        healthy = True
        try:
            result = await asyncio.wait_for(page.evaluate(RENDER_JS, code), RENDER_TIMEOUT_S)
            if "error" in result:
                return None, result["error"]
            png = await page.locator("#out").screenshot(type="png")
            return png, None
        except Exception:
            healthy = False  # a hung or crashed page is replaced, not reused
            raise
        finally:
            if not healthy:
                await page.close()
                page = await self.new_page()
            await self.pages.put(page)

    async def stop(self):
        await self.browser.close()
        await self.pw.stop()


async def render_mermaid(request: web.Request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Body must be JSON"}, status=400)
    code = (body.get("code") or "").strip()
    if not code:
        return web.json_response({"error": "code is required"}, status=400)
    if len(code) > MAX_CODE_CHARS:
        return web.json_response({"error": f"code is longer than {MAX_CODE_CHARS} characters"}, status=413)

    try:
        png, error = await request.app["pool"].render(code)
    except asyncio.TimeoutError:
        return web.json_response({"error": "Rendering timed out"}, status=504)
    if error:
        return web.json_response({"error": error}, status=422)
    return web.Response(body=png, content_type="image/png")


async def health(_request):
    return web.json_response({"ok": True})


async def on_startup(app):
    app["pool"] = Pool()
    await app["pool"].start()


async def on_cleanup(app):
    await app["pool"].stop()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_post("/render/mermaid", render_mermaid)
    app.router.add_get("/health", health)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "5002")), access_log=None)


if __name__ == "__main__":
    main()
