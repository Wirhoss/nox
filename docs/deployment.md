# Container deployment

Nox is distributed and supported as a Linux container. The image contains the
Bun runtime, built web interface, database migrations, builtin extensions, and
native dependencies needed by the runtime. Installing Bun or running Nox
directly on the host is not a deployment path.

Tagged release images support `linux/amd64` and `linux/arm64`.

---

## Start with Docker Compose

The repository includes [`compose.yaml`](../compose.yaml). It defaults to a
locally built image and uses named volumes, so the container can be replaced
without losing state.

```bash
docker build --build-arg NOX_VERSION=0.1.0 -t nox:local .
docker compose up -d
docker compose logs nox
```

Open [http://localhost:8080](http://localhost:8080). A fresh Nox asks for the
one-time claim code written to the container log. The code is held only in
memory, changes if the unclaimed container restarts, and stops working after the
first account is created.

Check container and application health with:

```bash
docker compose ps
curl --fail http://127.0.0.1:8080/api/health/live
curl --fail http://127.0.0.1:8080/api/health/ready
```

`live` reports whether the process is answering. `ready` reports whether it is
ready to receive traffic.

---

## Persistent state

The Compose file creates three named volumes:

| Volume | Container path | Contents |
|---|---|---|
| `nox-config` | `/etc/nox/config` | JSON desired-state configuration |
| `nox-data` | `/var/lib/nox` | SQLite databases, artifacts, authentication keys, and the secret-encryption key |
| `nox-extensions` | `/var/lib/nox/extensions` | Operator-installed extension packages |

The exact Docker volume names receive the Compose project prefix; use
`docker compose config --volumes` and `docker volume ls` to inspect them. Builtin
extensions are part of the image and do not use the extensions volume.

Back up all three volumes together. In particular, `.secret-key` in the data
volume must stay with the database: encrypted provider credentials cannot be
recovered without it. Stop Nox or use a storage-level snapshot that is
consistent across the volumes before copying them.

`docker compose down` removes the container and network but preserves named
volumes. **`docker compose down -v` deletes the installation state.**

---

## Networking and TLS

The default mapping is `127.0.0.1:8080:8080`, so Nox is reachable only from the
Docker host. Change the host port without changing the container configuration:

```bash
NOX_PORT=9090 docker compose up -d
```

To deliberately listen on every host interface, set `NOX_BIND_ADDRESS=0.0.0.0`
in a `.env` file beside `compose.yaml`:

```dotenv
NOX_BIND_ADDRESS=0.0.0.0
NOX_PORT=8080
```

Do not expose an unclaimed instance to an untrusted network. For remote access,
put Nox behind a TLS reverse proxy and set `auth.secureCookies` to `true` in
`app.json`. Network exposure, certificates, firewall policy, and proxy access
controls remain operator responsibilities.

---

## Select a release and update

Tagged releases publish versioned images to GHCR. To use one instead of the
locally built `nox:local` image, set it in a `.env` file beside `compose.yaml`:

```dotenv
NOX_IMAGE=ghcr.io/wirhoss/nox:0.1.0
```

Pin an exact version rather than relying on a floating tag. To update after
changing the pin:

```bash
docker compose pull
docker compose up -d
docker compose logs nox
```

Nox applies database migrations on startup. Back up the persistent volumes
before upgrading, especially while the project is pre-1.0.

---

## Source builds are still containers

Building the image from a source checkout requires Docker, not a host Bun
installation. The Dockerfile performs the Bun build in an intermediate stage;
the resulting runtime is still the container. Bun commands in this repository
are for contributors, CI, and extension builds, not for installing Nox on a
host.

---

## Stop and inspect

```bash
docker compose stop              # preserve the container and volumes
docker compose start
docker compose restart nox
docker compose logs --tail=200 nox
docker compose logs -f nox
docker compose down              # remove the container, preserve volumes
```

See [configuration.md](configuration.md) for the files stored in the config
volume and which changes apply live or require a container restart.
