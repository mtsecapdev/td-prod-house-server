# TD Prod House - Server Repo
Code here is for the backend side of the TD Prod House
## Python scripts setup

The renderers in `scripts/` (docx, pptx, infographics, PDF splitting) use a uv-managed environment.
Dependencies are declared in `pyproject.toml` and pinned in `uv.lock`.

```bash
uv sync                                        # creates .venv from uv.lock
uv run playwright install --with-deps chromium # headless browser for infographic rendering
```

Set `PYTHON_PATH=.venv/bin/python` in `.env`.
