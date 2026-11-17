# TD Prod House - Server Repo
Code here is for the backend side of the TD Prod House
## Services

`docker compose up -d` starts the supporting services:

| Service | Port | Purpose |
|---|---|---|
| `postgres` | 5432 | Postgres + pgvector |
| `docling` | 5001 | Converts uploaded files to markdown (GPU) |
| `renderer` | 5002 | Renders Mermaid diagrams to PNG for diagram slides and document figures |

The renderer is built from `renderer/` and keeps one headless Chromium running with a pool of pages
(`RENDER_POOL_SIZE`, default 4, caps concurrent renders). Its address is `RENDER_SERVICE_ENDPOINT`
(default `http://127.0.0.1:5002`). After changing `renderer/` or `scripts/vendor/`, rebuild it with
`docker compose up -d --build renderer`.

## Database

```bash
npm run table     # creates the base tables on a fresh database (after CREATE EXTENSION vector)
npm run migrate   # applies src/db/migrations/*.sql that have not run yet; run on every deploy
```

## Python scripts setup

The renderers in `scripts/` (docx, pptx, PDF splitting) use a uv-managed environment.
Dependencies are declared in `pyproject.toml` and pinned in `uv.lock`.

```bash
uv sync   # creates .venv from uv.lock
```

Set `PYTHON_PATH=.venv/bin/python` in `.env`.
