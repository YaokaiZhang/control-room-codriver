#!/usr/bin/env bash
# Runs the control room in Apptainer instead of Docker, for hosts without Docker.
# The same images as compose.yaml, plus Node for the dev server, as three instances: bahn-db, bahn-s3, bahn-web.
#   scripts/apptainer.sh start     pull images if missing, start the services, schema, seed if empty, dev server
#   scripts/apptainer.sh restart   stop everything, then start (data is kept)
#   scripts/apptainer.sh stop      stop the dev server, the object store and Postgres
#   scripts/apptainer.sh status    list the instances and their log files
# Ports come from .env (DATABASE_URL, S3_ENDPOINT) and PORT (default 53000). Images, data and the npm
# cache live in BAHN_RUNTIME (default: bahn-runtime next to the repository).
set -euo pipefail

cd "$(dirname "$0")/.."
starter=$(pwd)
root=$(dirname "$starter")
RUNTIME="${BAHN_RUNTIME:-$(dirname "$root")/bahn-runtime}"
PORT="${PORT:-53000}"
export APPTAINER_CACHEDIR="$RUNTIME/apptainer-cache" APPTAINER_TMPDIR="$RUNTIME/apptainer-tmp"

DB_IMAGE=postgres:17-alpine
S3_IMAGE=rustfs/rustfs:1.0.1
NODE_IMAGE=node:24-bookworm-slim

step() { printf '\n==> %s\n' "$*"; }
sif() { echo "$RUNTIME/images/$(echo "$1" | tr '/:' '__').sif"; }
running() { apptainer instance list "$1" 2>/dev/null | grep -q "^$1 "; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Set ANTHROPIC_API_KEY in it for the reviewer and voice agent."
fi
set -a; source .env; set +a
# postgres://user:password@host:port/database
[[ "$DATABASE_URL" =~ ^postgres://([^:]+):([^@]+)@[^:]+:([0-9]+)/(.+)$ ]] || { echo "Cannot parse DATABASE_URL" >&2; exit 1; }
DB_USER=${BASH_REMATCH[1]} DB_PASSWORD=${BASH_REMATCH[2]} DB_PORT=${BASH_REMATCH[3]} DB_NAME=${BASH_REMATCH[4]}
[[ "$S3_ENDPOINT" =~ :([0-9]+)/?$ ]] || { echo "Cannot parse S3_ENDPOINT" >&2; exit 1; }
S3_PORT=${BASH_REMATCH[1]}

# Runs a command in the Node image with the repository mounted, like `docker compose run`.
node_exec() {
  apptainer exec --cleanenv --bind "$root" --bind "$RUNTIME" --pwd "$starter" \
    --env "npm_config_cache=$RUNTIME/npm-cache,http_proxy=${http_proxy:-},https_proxy=${https_proxy:-},no_proxy=${no_proxy:-}" \
    "$(sif $NODE_IMAGE)" "$@"
}

wait_for() {
  local name=$1 check=$2
  for _ in $(seq 1 60); do
    if eval "$check" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$name did not come up within 60 s. See its log under: apptainer instance list --logs" >&2
  exit 1
}

start() {
  step "Images"
  mkdir -p "$RUNTIME/images" "$APPTAINER_CACHEDIR" "$APPTAINER_TMPDIR"
  for image in $DB_IMAGE $S3_IMAGE $NODE_IMAGE; do
    if [[ -f "$(sif "$image")" ]]; then echo "$image cached."; else apptainer -q pull "$(sif "$image")" "docker://$image"; fi
  done

  step "Postgres on :$DB_PORT"
  if running bahn-db; then
    echo "Already running."
  else
    mkdir -p "$RUNTIME/pgdata" "$RUNTIME/pgrun"
    apptainer instance run --cleanenv \
      --bind "$RUNTIME/pgdata:/var/lib/postgresql/data" --bind "$RUNTIME/pgrun:/var/run/postgresql" \
      --env "POSTGRES_USER=$DB_USER,POSTGRES_PASSWORD=$DB_PASSWORD,POSTGRES_DB=$DB_NAME,PGPORT=$DB_PORT" \
      "$(sif $DB_IMAGE)" bahn-db postgres -c listen_addresses=127.0.0.1
  fi
  wait_for Postgres "apptainer exec instance://bahn-db pg_isready -h 127.0.0.1 -p $DB_PORT -U $DB_USER -d $DB_NAME"

  step "Object store on :$S3_PORT"
  if running bahn-s3; then
    echo "Already running."
  else
    mkdir -p "$RUNTIME/s3data"
    # rustfs writes telemetry files inside the image, which Apptainer mounts read-only.
    apptainer instance run --cleanenv --writable-tmpfs --bind "$RUNTIME/s3data:/data" \
      --env "RUSTFS_ACCESS_KEY=$S3_ACCESS_KEY_ID,RUSTFS_SECRET_KEY=$S3_SECRET_ACCESS_KEY,RUSTFS_ADDRESS=127.0.0.1:$S3_PORT,RUSTFS_CONSOLE_ADDRESS=127.0.0.1:$((S3_PORT + 1)),RUSTFS_CONSOLE_ENABLE=true" \
      "$(sif $S3_IMAGE)" bahn-s3 /data
  fi
  wait_for "Object store" "curl -fsS http://127.0.0.1:$S3_PORT/health"

  step "Dependencies"
  if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    node_exec npm ci
  else
    echo "Up to date."
  fi

  step "Schema"
  # No TTY: drizzle-kit fails instead of waiting on a data-loss prompt, so a destructive change stops here.
  node_exec npm run --silent db:push </dev/null

  step "Snapshot"
  orders=$(apptainer exec --env "PGPASSWORD=$DB_PASSWORD" instance://bahn-db \
    psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "select count(*) from orders")
  if [[ "$orders" == "0" ]]; then
    node_exec npm run db:seed
  else
    echo "$orders orders already seeded. Run npm run db:seed to reset the snapshot."
  fi

  step "Attachments"
  node_exec npm run --silent attachments:seed

  step "Dev server on :$PORT"
  if running bahn-web; then
    echo "Already running. Use restart to restart it."
  else
    # instance run has no --pwd, so the dev server changes directory itself. The image's runscript
    # re-evaluates arguments, so the directory and port go in as variables, not positional arguments.
    apptainer instance run --cleanenv --bind "$root" --bind "$RUNTIME" \
      --env "BAHN_STARTER=$starter,BAHN_PORT=$PORT,npm_config_cache=$RUNTIME/npm-cache,http_proxy=${http_proxy:-},https_proxy=${https_proxy:-},no_proxy=${no_proxy:-}" \
      "$(sif $NODE_IMAGE)" bahn-web sh -c 'cd "$BAHN_STARTER" && exec npm run dev -- --port "$BAHN_PORT" --hostname 127.0.0.1'
  fi

  step "Health"
  # /api/clock reads the engine tables, so a 200 means the schema and the server both work.
  wait_for "Dev server" "[[ \$(curl -s -o /dev/null -w '%{http_code}' -b persona=operator http://127.0.0.1:$PORT/api/clock) == 200 ]]"
  # The services listen on this login node only, so the tunnel names the node, not the round-robin alias.
  echo "Ready at http://127.0.0.1:$PORT on $(hostname -s). From your machine:"
  echo "  ssh -N -L $PORT:127.0.0.1:$PORT $(whoami)@$(hostname -s).csc.fi"
}

stop() {
  step "Stopping"
  # The dev server first, so no client holds Postgres open. SIGINT is Postgres's fast shutdown.
  for name in bahn-web bahn-s3 bahn-db; do
    if running "$name"; then
      signal=SIGTERM; [[ "$name" == bahn-db ]] && signal=SIGINT
      apptainer instance stop -s "$signal" -t 30 "$name"
    else
      echo "$name is not running."
    fi
  done
}

case "${1:-}" in
  start) start ;;
  restart) stop; start ;;
  stop) stop ;;
  status) apptainer instance list --logs 'bahn-*' ;;
  *) echo "Usage: $0 start|restart|stop|status" >&2; exit 2 ;;
esac
