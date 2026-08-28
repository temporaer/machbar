# Deployment and configuration

Machbar serves its API and compiled web application from one Node.js process.
Production data is stored in a SQLite file.

## Docker Compose

Build and start the included service:

```bash
docker compose up --build -d
```

The default host-local URL is `http://localhost:3000`. The Compose port is
bound to `127.0.0.1`, so remote clients must use a reverse proxy. Set another
host port in a root `.env` file:

```dotenv
MACHBAR_PORT=8080
```

The named `machbar-data` volume is mounted at `/data`.

```bash
docker compose logs -f
docker compose down
```

`docker compose down` preserves the volume. `docker compose down -v` deletes
it and therefore deletes the database.

## Docker without Compose

```bash
docker build -t machbar .
docker run -d \
  --name machbar \
  -p 127.0.0.1:3000:3000 \
  -v machbar-data:/data \
  machbar
```

To start a disposable demo with sample data, add
`-e SEED_DATABASE=true`. Seeding is intended for demos and development, not
for an existing household database.

## Standalone npm

Requirements: Node.js 22 or later and npm 10 or later.

```bash
npm install
npm run build
SEED_DATABASE=false npm run start
```

The API applies pending database migrations during startup and also serves the
compiled frontend. Set `DATA_DIR` to keep production data outside the source
checkout:

```bash
SEED_DATABASE=false DATA_DIR=/var/lib/machbar npm run start
```

## Upgrades

Back up the database, update the source checkout or image, rebuild, and restart
the service:

```bash
docker compose down
git pull --ff-only
docker compose up --build -d
```

Pending migrations run during startup. Review release notes and migration
changes before upgrading an important installation.

## Health check

`GET /api/health` returns a successful JSON response while the API is running.
The production Docker image includes a health check that polls this endpoint.

```bash
docker inspect --format='{{.State.Health.Status}}' machbar
```

With Compose, obtain the generated container name with `docker compose ps`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port inside the process/container |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` outside Docker, `/data` in the image | Database directory |
| `DATABASE_FILE` | `machbar.db` | SQLite filename inside `DATA_DIR` |
| `BASE_PATH` | `/` | Preserved URL prefix for sub-path deployments |
| `SEED_DATABASE` | `true` outside the image, `false` in the image | Seed sample data during startup when the database has no members |
| `NODE_ENV` | `development` outside the image | Runtime mode |
| `OIDC_ISSUER_URL` | unset | Pocket ID issuer |
| `OIDC_CLIENT_ID` | unset | Pocket ID client ID |
| `OIDC_CLIENT_SECRET` | unset | Pocket ID client secret |
| `OIDC_PUBLIC_URL` | unset | Exact public HTTPS origin |
| `OIDC_SESSION_TTL_DAYS` | `30` | Local session lifetime, 1–365 days |

The application treats a partial OIDC configuration as a startup error.
Production also refuses to start when OIDC is completely unset; unauthenticated
mode is limited to development and tests.

## Reverse proxy

### Caddy

```caddy
machbar.example.com {
    reverse_proxy localhost:3000
}
```

### nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Terminate HTTPS at the reverse proxy when the instance is exposed beyond a
trusted local network.

## Sub-path deployment

If the proxy preserves a prefix such as `/tasks/`, set:

```dotenv
BASE_PATH=/tasks
```

The frontend uses relative assets and hash routing, so changing the prefix
does not require a frontend rebuild. Home Assistant Ingress strips its dynamic
prefix before forwarding requests and should keep `BASE_PATH=/`.

## Pocket ID OpenID Connect

Machbar can require Pocket ID authentication at its direct HTTPS origin.
Create an OIDC client with:

- redirect URI: `https://machbar.example.com/api/auth/callback`
- scopes: `openid profile email`
- authorization-code flow with PKCE S256

Configure all required values together:

```dotenv
OIDC_ISSUER_URL=https://pocketid.example.com
OIDC_CLIENT_ID=replace-with-client-id
OIDC_CLIENT_SECRET=replace-with-client-secret
OIDC_PUBLIC_URL=https://machbar.example.com
OIDC_SESSION_TTL_DAYS=30
```

`OIDC_PUBLIC_URL` must be an exact HTTPS origin without a path. The browser
receives an opaque Secure, HttpOnly, SameSite=Lax session cookie; provider
tokens and the client secret remain server-side.

On first login, Machbar attempts to link the Pocket ID subject to an unlinked
member with a matching display name, or a unique matching preferred username.
Otherwise it creates a member. The immutable OIDC subject is authoritative
after linking, and OIDC-managed members cannot be renamed or deleted inside
Machbar.

Restrict the Pocket ID client to the intended household users. The local
identity selector is convenient on a trusted network but is not an access
control boundary.

OIDC cookies belong to the configured direct origin. A separate Home Assistant
Ingress origin cannot share that session.

## Backups

The durable asset is the SQLite file at
`$DATA_DIR/$DATABASE_FILE`.

For a consistent simple backup, stop the service and copy the file from the
Compose container:

```bash
docker compose stop machbar
docker compose cp machbar:/data/machbar.db ./machbar.db
docker compose start machbar
```

For live backups, use SQLite’s backup API or the `sqlite3` `.backup` command
against the database file. Test restore procedures on a separate copy before
depending on them.

To restore a Compose deployment, stop Machbar, preserve the current file
separately, and copy the backup into the container’s mounted data directory:

```bash
docker compose stop machbar
docker compose cp ./machbar.db machbar:/data/machbar.db
docker compose start machbar
```

Start the same or a newer application version so pending migrations can run.
