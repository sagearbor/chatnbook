# AI-Native Chat + Agent-Ready Scheduling (SMB)

Human-friendly chat/booking widget **and** agent-discoverable scheduling API.
Connects to existing calendars (Google/Microsoft) with ICS read-only fallback.
Ships as a one-click WordPress plugin wrapper; other platforms generated via manifests.

## Quick Start
```bash
# Node 20+ recommended
corepack enable
corepack prepare pnpm@9 --activate

pnpm i
docker compose -f infra/docker-compose.dev.yml up -d  # Postgres + Redis
pnpm -r build
pnpm --filter @smb/api dev   # serves /openapi.json and stub endpoints
```

Generate the WordPress plugin skeleton (thin wrapper):
```bash
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
# output: platforms_out/wordpress-plugin/
```

Configure env:
```bash
cp .env.example .env
# fill Google/Microsoft OAuth, Stripe, etc.
```

Sanity checks:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/openapi.json
```

- `plan.yaml`: AI-editable development checklist.
- `agents/agent_instructions.yaml`: instructions file for AI dev bots.

## Testing
We use `pytest` with the `pytest-testdox` plugin for readable output.

```bash
python -m venv .venv
source .venv/bin/activate        # or .venv\Scripts\activate on Windows
pip install -r packages/connectors-py/requirements.txt
pytest                           # prints grouped, one-line checks
### If you don’t like the default style, override it:
Verbose: pytest -vv -rP
Show durations: pytest --durations=5
