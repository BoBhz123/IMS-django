# Frontend image — the Vite dev server for the React SPA, LOCAL DEVELOPMENT only.
#
# Production never uses this. Heroku's nodejs buildpack runs the root package.json's
# `heroku-postbuild` (npm ci + vite build in frontend/, then deletes node_modules), and the
# python buildpack's WhiteNoise serves the resulting frontend/dist. See ims/settings.py's
# WHITENOISE_ROOT and ims/views.py::spa_index.

# Node 22, NOT the 20 that was requested. The root package.json declares
# `"engines": { "node": "22.x" }`, which is what Heroku's nodejs buildpack installs to build
# this exact app — so 22 is the version the production bundle is actually compiled by, and
# matching it here is the whole point of "zero Heroku regressions". node:20-alpine would
# technically work (20.19.x satisfies vite@8's `^20.19.0 || >=22.12.0`), but it would put the
# container one major behind the build that ships, which is where subtle bundling differences
# come from. Change this line to node:20-alpine if you want the letter of the spec instead.
#
# -alpine is musl-based rather than glibc. That matters for this project because vite/rollup,
# @tailwindcss/oxide, lightningcss and oxlint all ship prebuilt *native* binaries per libc.
# Verified before choosing it: package-lock.json (lockfileVersion 3) contains the
# `*-linux-x64-musl` variants of all four, so `npm ci` resolves them correctly here.
FROM node:22-alpine

# Everything below resolves against /app, and it is where `docker compose exec frontend ...`
# lands. Must match the bind-mount target in docker-compose.yml.
WORKDIR /app

# --- Dependency layer -------------------------------------------------------------------
# Manifest + lockfile first, alone, for the same cache reason as the backend: source edits
# happen constantly, dependency changes rarely. Copying the whole frontend first would re-run
# a full npm install on every component edit.
COPY package.json package-lock.json ./

# `npm ci`, not `npm install`. ci installs exactly what package-lock.json pins, refuses to run
# if the lockfile and package.json disagree, and never rewrites the lockfile — so a Docker
# build can't silently drift dependency versions the way `npm install` can. It also deletes any
# pre-existing node_modules first, which makes the layer deterministic.
#
# No --omit=dev: vite, vitest and oxlint are all devDependencies, and this image's entire job
# is to run the dev server and the test suite.
RUN npm ci

# --- Application layer ------------------------------------------------------------------
# Filtered by frontend/.dockerignore. Shadowed by the bind mount under compose; present so the
# image builds and runs standalone.
COPY . .

# Vite's configured port (see vite.config.js server.port). Declarative only — the host binding
# is the compose `ports:` mapping.
EXPOSE 5173

# `--` passes the flags through npm to vite rather than to npm itself.
#
# --host 0.0.0.0 is mandatory in a container. Vite binds to localhost by default, which is the
# *container's* loopback — the published port would connect and immediately get nothing. This
# also makes Vite serve on all interfaces, which is why vite.config.js's `allowedHosts`
# DNS-rebinding guard still matters; requests arriving with Host `localhost:5173` are always
# permitted by Vite, so the compose setup needs no change there.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
