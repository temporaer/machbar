# Home Assistant

The repository contains development packaging for running Machbar as a Home
Assistant add-on. It is not currently a published, one-click add-on
repository.

## What the add-on packaging does

- builds Machbar for supported Home Assistant architectures;
- stores the SQLite database in the add-on’s persistent `/data` directory;
- exposes the UI through Home Assistant Ingress;
- optionally exposes port 3000 for direct access;
- supports a `seed_database` development option.

The relevant files live in `home-assistant/`.

## Local development installation

Build the image from the repository root:

```bash
docker build -f home-assistant/Dockerfile -t local/machbar .
```

For a local add-on checkout, copy or link the add-on files into a directory
under Home Assistant’s local add-ons path, then set the add-on configuration’s
image to:

```yaml
image: "local/machbar"
```

The exact local add-on workflow depends on the Home Assistant installation and
is intended for development rather than end-user distribution.

## Ingress

The add-on declares Ingress on port 3000. Home Assistant strips its generated
Ingress prefix before forwarding traffic, so Machbar should run with:

```dotenv
BASE_PATH=/
```

The add-on appears as a Machbar side-panel entry when installed.

## Options

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `seed_database` | boolean | `false` | Insert sample data for a fresh development/demo installation |

## Direct port

The add-on configuration leaves `3000/tcp` disabled by default. Enable a host
port in the Home Assistant add-on configuration only when direct access is
needed.

Direct access and Ingress use different browser origins. Pocket ID sessions
configured for a direct HTTPS origin cannot be shared with the Home Assistant
Ingress origin.

## Distribution status

Publishing a supported add-on requires more than making this repository
public. Before advertising repository installation, the project still needs
to verify the expected add-on repository layout, publish architecture-specific
images, pin and update base images, define an image/version release process,
and test installation and upgrades on supported Home Assistant systems.

## Native integration ideas

A future Home Assistant integration could expose selected Machbar state,
services, notifications, or automation triggers. Those ideas are not a
supported public API today. Example REST sensors and service calls have
therefore been removed from the main documentation rather than presented as
working integrations.

