# Deployment and configuration

Machbar serves its API and compiled web application from one Node.js process.
Production data is stored in a SQLite file.

## Docker Compose

Build and start the included service:

```bash
docker compose up --build -d
```

For evaluation on a trusted machine without an OIDC provider, create a root
`.env` file first:

```dotenv
ALLOW_UNAUTHENTICATED=true
```

This mode gives every client full access. Do not expose an unauthenticated
instance to the internet.

The default host-local URL is `http://localhost:3000`. The Compose port is
bound to `127.0.0.1`, so remote clients must use a reverse proxy. Set another
host port in a root `.env` file:

```dotenv
MACHBAR_PORT=8080
```

If the reverse proxy itself runs in a container and reaches Machbar through
the host address, expose the port on the host interfaces explicitly:

```dotenv
MACHBAR_BIND_ADDRESS=0.0.0.0
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
  -e ALLOW_UNAUTHENTICATED=true \
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
| `MACHBAR_BIND_ADDRESS` | `127.0.0.1` | Host address used by the Compose port mapping |
| `MACHBAR_PORT` | `3000` | Host port used by the Compose port mapping |
| `PORT` | `3000` | Port inside the process/container |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` outside Docker, `/data` in the image | Database directory |
| `DATABASE_FILE` | `machbar.db` | SQLite filename inside `DATA_DIR` |
| `BASE_PATH` | `/` | Preserved URL prefix for sub-path deployments |
| `SEED_DATABASE` | `true` outside the image, `false` in the image | Seed sample data during startup when the database has no members |
| `NODE_ENV` | `development` outside the image | Runtime mode |
| `ALLOW_UNAUTHENTICATED` | `false` | Set to `true` to explicitly run production without authentication |
| `OIDC_ISSUER_URL` | unset | Pocket ID issuer |
| `OIDC_CLIENT_ID` | unset | Pocket ID client ID |
| `OIDC_CLIENT_SECRET` | unset | Pocket ID client secret |
| `OIDC_PUBLIC_URL` | unset | Exact public HTTPS origin |
| `OIDC_SESSION_TTL_DAYS` | `30` | Local session lifetime, 1–365 days |
| `VAPID_PUBLIC_KEY` | unset | Public VAPID key exposed to browsers when Web Push is enabled |
| `VAPID_PRIVATE_KEY` | unset | Private VAPID signing key; keep it only in deployment secrets or the uncommitted `.env` |
| `VAPID_SUBJECT` | unset | HTTPS URL or `mailto:` contact identifying the Push sender |
| `PAPERLESS_URL` | unset | HTTPS base URL of the optional Paperless-ngx instance |
| `PAPERLESS_API_TOKEN` | unset | Server-only Paperless API token; configure together with `PAPERLESS_URL` |

The application treats a partial OIDC configuration as a startup error.
Production refuses to start when OIDC is completely unset unless
`ALLOW_UNAUTHENTICATED=true` explicitly enables unauthenticated mode.
Web Push is optional, but a partial VAPID configuration is also a startup
error. Paperless is optional as well; setting only its URL or only its token is
a startup error.

## Paperless-ngx attachments

Configure both values to enable image and document attachments:

```dotenv
PAPERLESS_URL=https://paperless.example.com
PAPERLESS_API_TOKEN=replace-with-a-dedicated-api-token
```

The token is used only by the Machbar server. Browsers upload through
authenticated same-origin Machbar routes and never receive the token or an
authenticated Paperless URL. Paperless physically stores and processes every
file; task and project notes contain only stable `paperless:<document-id>`
Markdown references.

Machbar requests Paperless API version 10 explicitly and automatically retries
with the compatible version 9 contract when an older server rejects version 10.

Once configured, every Markdown notes editor can capture a photo with the
device's native camera flow, choose an image/file, or search existing Paperless
documents. Installed Android PWAs can also receive files through the system
share sheet. Incoming files are staged locally until sign-in and destination
selection complete, then uploaded with a 25 MB per-file limit.

## Web Push notifications

Web Push is supported through the same standards-based service-worker flow in
compatible desktop and mobile browsers/PWAs. It requires HTTPS at the
browser-facing origin (localhost is the usual development exception). Generate
a VAPID key pair once for an installation:

```bash
npx web-push generate-vapid-keys
```

Store the generated values outside source control:

```dotenv
VAPID_PUBLIC_KEY=replace-with-generated-public-key
VAPID_PRIVATE_KEY=replace-with-generated-private-key
VAPID_SUBJECT=https://machbar.example.com
```

The private key never leaves the server. Each desktop or mobile browser/PWA
must be enabled separately under **More → Notifications** and keeps an
independent Push subscription. A member may subscribe several devices and
receives each event on all of them; a shared unauthenticated browser is
reassociated when its selected Machbar identity changes. Service-worker
delivery does not require an open Machbar tab or window.

The current version sends Push notifications only when another person assigns
or reassigns a task/project to the member, or when an explicit task
`reminderAt` becomes due. It does not send due-date digests, workflow-hygiene
alerts, comments, or mentions.

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
