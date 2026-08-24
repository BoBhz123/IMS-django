# Backend image — Django + DRF, for LOCAL DEVELOPMENT under docker compose.
#
# Production is Heroku, built by buildpacks from Procfile + Pipfile + package.json. This file
# is additive and invisible to that path: Heroku only builds a Dockerfile when the stack is
# set to `container` AND a heroku.yml exists. Neither is true here, and neither is added.
# See the "Heroku parity" notes at the bottom.

# Python 3.14, NOT the 3.12 that was requested — Pipfile and Pipfile.lock both pin
# `python_version = "3.14"`, and `pipenv install --deploy` aborts the build on a version
# mismatch by design (that is most of what --deploy is for). Building on 3.12 would mean
# dropping --deploy, which also drops the Pipfile.lock hash check — so the container could
# silently resolve different package versions than Heroku installs. 3.14 also matches the
# host interpreter (3.14.6), so the container and `pipenv run` behave identically.
FROM python:3.14-slim

# PYTHONDONTWRITEBYTECODE — no .pyc files. Two reasons here specifically: the source tree is
#   bind-mounted from the host, so bytecode written by root inside the container would land in
#   the developer's working copy as root-owned __pycache__ directories; and stale .pyc files
#   are a classic source of "I changed the file and nothing happened".
# PYTHONUNBUFFERED — send stdout/stderr straight through instead of block-buffering. Without
#   it, Django's runserver output and the ims.security audit logger (settings.LOGGING writes
#   to a StreamHandler) appear in `docker compose logs` in delayed chunks, or not at all when
#   a container is killed mid-buffer.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# System packages, resolved from what this project's Pipfile actually pulls in:
#   build-essential  gcc/g++/make — needed if any dependency has no cp314 wheel yet and must
#                    compile from sdist. 3.14 is new enough that this is a live risk.
#   libpq-dev        provides pg_config + libpq headers. psycopg2-binary normally ships a
#                    self-contained wheel, but if it ever falls back to an sdist build this is
#                    the difference between a working image and "pg_config executable not found".
#   libjpeg-dev
#   zlib1g-dev       Pillow's JPEG and PNG codecs — ProductImage uploads go through Pillow via
#                    ImageField, so a Pillow without them raises on the first product photo.
#   libffi-dev       cryptography's CFFI layer (accounts/crypto.py Fernet field encryption).
# `--no-install-recommends` skips suggested extras, and deleting /var/lib/apt/lists in the SAME
# RUN keeps the ~40MB package index out of the committed layer — a later `rm` in its own RUN
# would not shrink the image, because layers are additive and the earlier one still holds it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libjpeg-dev \
        zlib1g-dev \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Every relative path after this resolves against /app, and it is the default directory for
# `docker compose exec backend ...`. Matches the bind-mount target in docker-compose.yml.
WORKDIR /app

RUN pip install pipenv

# --- Dependency layer -------------------------------------------------------------------
# Copied BEFORE the source, on its own, because Docker caches each layer against the files it
# was built from. Application code changes many times an hour; Pipfile.lock changes maybe once
# a month. Copying `. .` first would invalidate the install layer on every single edit and make
# each rebuild re-download every wheel.
COPY Pipfile Pipfile.lock ./

# --system   installs into the image's own site-packages rather than creating a virtualenv.
#            A container is already an isolated environment; a venv inside one buys nothing and
#            costs a PATH indirection. It also matters for the bind mount below: packages live
#            in /usr/local/lib/python3.14/, outside /app, so mounting the host tree over /app
#            cannot shadow them. A venv at /app/.venv would be wiped by that mount.
# --deploy   refuses to install if Pipfile.lock is out of sync with Pipfile (hash mismatch) or
#            if the interpreter does not match `[requires] python_version`. This is the check
#            that makes the image reproducible, and the reason for the 3.14 base above.
RUN pipenv install --system --deploy

# pip-audit is a TEST-ONLY tool, installed with plain pip and deliberately NOT added to the
# Pipfile. Two reasons, both important:
#
#   1. `pipenv install <pkg>` relocks the entire dependency graph, which has already caused a
#      silent drive-by upgrade in this repo (Django 6.0.8 -> 6.1, DRF 3.17 -> 3.18 — see
#      CLAUDE.md's working log). Touching Pipfile.lock is the one change that could actually
#      alter what Heroku installs, so this Dockerfile must not do it.
#   2. It is not an application dependency and has no business in the production slug.
#
# Without it, inventory.tests.OWASP...test_a06_no_declared_python_dependency_has_a_known_cve
# calls self.skipTest() and the suite reports "OK (skipped=1)" — a supply-chain check silently
# not running, while the host (which has pip-audit) reports the failure it is meant to catch.
# A green suite that is green because a test did not run is the worst of both worlds.
RUN pip install pip-audit

# --- Application layer ------------------------------------------------------------------
# Filtered by .dockerignore (.git, .venv, node_modules, frontend/dist, .env, media, ...).
# Under compose this is immediately shadowed by the `.:/app` bind mount, so it exists for the
# benefit of `docker build` on its own — the image is self-contained and runnable without compose.
COPY . .

# Documentation + a hint to tooling; it publishes nothing by itself. The actual host binding is
# the `ports:` mapping in docker-compose.yml.
EXPOSE 8000

# 0.0.0.0, not the 127.0.0.1 runserver defaults to: a container has its own loopback, so a
# server bound to 127.0.0.1 inside it is unreachable from the host no matter how the port is
# published. This is the single most common "the port is mapped but nothing answers" cause.
#
# runserver, not gunicorn, is deliberate and is the dev/prod split: runserver gives the
# autoreloader that makes the bind mount worth having. Heroku's Procfile runs
# `gunicorn ims.wsgi` and is untouched by this line.
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
