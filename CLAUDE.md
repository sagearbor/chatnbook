# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
AI-Native Chat + Agent-Ready Scheduling for SMBs. This is a monorepo that provides both human-friendly chat/booking widgets and agent-discoverable scheduling APIs. The system connects to existing calendars (Google/Microsoft) with ICS read-only fallback and ships as a one-click WordPress plugin.

## Development Commands

### Setup
```bash
# Prerequisites: Node 20+, Python 3.9+, Docker
corepack enable
corepack prepare pnpm@9 --activate
pnpm i
docker compose -f infra/docker-compose.dev.yml up -d  # Postgres + Redis
pnpm -r build

# Python environment for connectors
python -m venv .venv
source .venv/bin/activate        # or .venv\Scripts\activate on Windows
pip install -r packages/connectors-py/requirements.txt
```

### Development
```bash
pnpm --filter @smb/api dev      # Start API server with OpenAPI endpoints
pnpm -r build                   # Build all packages
pnpm dev                        # Run all dev servers in parallel
```

### WordPress Plugin Generation
```bash
pnpm generate:adapter --manifest platforms/wordpress.manifest.yaml
# Output: platforms_out/wordpress-plugin/
```

### Testing
```bash
# Python tests (connectors/availability logic)
pytest                          # Run all tests with testdox output (default)
pytest -vv -rP                  # Verbose mode with detailed output
pytest --durations=5            # Show slowest tests

# WordPress plugin testing
cd platforms/wordpress-plugin
docker compose -f docker-compose.test.yml up -d  # Start WordPress + MySQL
# Access: http://localhost:8080 (WordPress), http://localhost:8081 (PHPMyAdmin)
```

### Health Checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/openapi.json
```

## Architecture

### Core Components
- **API** (`packages/api/`): OpenAPI-first booking endpoints, availability engine, notification service
- **Connectors** (`packages/connectors-py/`): Python package for Google/Microsoft OAuth + ICS read-only calendar integration
- **Discovery** (`packages/discovery/`): JSON-LD generation and well-known endpoints for agent discoverability
- **Widget** (`packages/widget/`): Web widget with human-friendly chat UI and agent-friendly DOM mode
- **Adapters** (`packages/adapters/mcp/`): MCP tool server for agent integrations
- **WordPress Plugin** (`platforms/wordpress-plugin/`): Generated wrapper that injects widget + JSON-LD

### Key Data Flow
1. **Discovery**: Agents find scheduling capabilities via JSON-LD at `/.well-known/ai-actions.json`
2. **Availability**: Query `/v1/availability` with service/time parameters 
3. **Booking**: Create appointments via `/v1/appointments` with idempotency tokens
4. **Calendar Sync**: Connectors handle OAuth writes or ICS read-only with confirmation workflow

### Platform Generation
The `tools/adapter-gen/` generates platform-specific wrappers from YAML manifests. WordPress is the primary target, with templates in `tools/adapter-gen/templates/wordpress/`.

## Testing Strategy
- **Python tests** in `packages/connectors-py/tests/` focus on availability math, DST handling, and calendar connector logic
- **pytest-testdox** provides readable test output grouped by functionality
- **WordPress testing** via Docker environment in `platforms/wordpress-plugin/` with live WordPress + MySQL
- Critical test areas: double-booking prevention, OAuth token refresh, ICS confirmation workflow, plugin activation/deactivation

## Security & Agent Integration
- **HMAC authentication** required for agent API calls (X-Signature header)
- **Rate limiting** per IP (human GUI) and per account (agent API)
- **OAuth-only calendar writes**; ICS is read-only with manual confirmation
- **Agent mode**: Widget supports `?agent=1` query param for simplified DOM with stable data-* selectors

## Configuration
- Copy `.env.example` to `.env` and configure OAuth credentials, database URLs, HMAC secrets
- See `agents/agent_instructions.yaml` for comprehensive environment variable requirements
- WordPress plugin handles OAuth setup UI for non-technical users

## Development Principles
- **API-first**: JSON-LD advertises capabilities, OpenAPI specifies implementation
- **Agent-friendly**: Stable DOM selectors, deterministic responses, clear error messages  
- **Security-by-default**: HMAC for agents, OAuth for calendar writes, PII scrubbing in logs
- **Monorepo structure**: Use `pnpm --filter` for package-specific commands