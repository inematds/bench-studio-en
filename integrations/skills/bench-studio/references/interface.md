# Local interface

Bench web UI: `http://localhost:5200`

Bench API: `http://localhost:8787`

The MCP command is machine-specific. Open Bench's **Connect** tab and copy the current configuration rather than hard-coding a repository path.

Core HTTP routes:

- `GET /api/models`
- `GET /api/capabilities`
- `POST /api/upload`
- `POST /api/generate`
- `GET /api/ledger`
- `GET /api/storage`
- `POST /api/projects`
- `GET /api/projects?kind=website|document`
- `GET /api/projects/:id`

Prefer MCP as the stable contract. Use HTTP only for diagnostics or in environments where stdio MCP cannot be configured.
