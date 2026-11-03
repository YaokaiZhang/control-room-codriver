#!/usr/bin/env bash
# Brings the control room up, or catches a running one up with the code. Safe to re-run.
#   scripts/start.sh            install, services, schema, seed if empty, dev server if not running
#   scripts/start.sh --restart  same, but restarts the dev server
#   scripts/start.sh --clean    restarts with an empty .next cache (fixes a page stuck reloading after a big merge)
#   scripts/start.sh --demo     then the demo pre-flight: review the demo orders, reset the clock to 09:00
# Flags combine, for example `--restart --demo`. The dev server logs to /tmp/next-dev.log.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
LOG=/tmp/next-dev.log
# The orders the demo walks through (docs/PRD.md §6.5 and the spec's demo journeys).
DEMO_ORDERS=(CD-420516 CD-420437 CD-420089 CD-420399 CD-420656 CD-420458 CD-420015 CD-420806 CD-420311)
restart=false
clean=false
demo=false
for arg in "$@"; do
  case "$arg" in
    --restart) restart=true ;;
    --clean) restart=true; clean=true ;;
    --demo) demo=true ;;
    *) echo "Unknown option $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

step "Environment"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Set ANTHROPIC_API_KEY in it for the reviewer and voice agent."
fi

step "Dependencies"
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci
else
  echo "Up to date."
fi

step "Postgres and object store"
docker compose up -d --wait

step "Schema"
# No TTY: drizzle-kit fails instead of waiting on a data-loss prompt, so a destructive change stops here.
npm run --silent db:push </dev/null

step "Snapshot"
orders=$(docker compose exec -T db psql -U controlroom -d controlroom -tAc "select count(*) from orders")
if [[ "$orders" == "0" ]]; then
  npm run db:seed
else
  echo "$orders orders already seeded. Run npm run db:seed to reset the snapshot."
fi

step "Attachments"
npm run --silent attachments:seed

step "Dev server"
pids=$(pgrep -f "next dev|next-server" || true)
if [[ -n "$pids" && "$restart" == true ]]; then
  echo "Stopping $pids"
  kill $pids
  while pgrep -f "next dev|next-server" >/dev/null; do sleep 0.5; done
  pids=""
fi
if [[ "$clean" == true ]]; then
  rm -rf .next
  echo "Cleared .next"
fi
if [[ -z "$pids" ]]; then
  setsid nohup npm run dev -- --port "$PORT" >"$LOG" 2>&1 </dev/null &
  echo "Started on :$PORT, logging to $LOG"
else
  echo "Already running. Use --restart to restart it."
fi

step "Health"
healthy=false
for _ in $(seq 1 60); do
  # /api/clock reads the engine tables, so a 200 means the schema and the server both work.
  code=$(curl -s -o /dev/null -w '%{http_code}' -b persona=operator "http://localhost:$PORT/api/clock" || true)
  if [[ "$code" == "200" ]]; then
    echo "Ready at http://localhost:$PORT"
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo "No healthy answer after 60s (last status $code). Last log lines:"
  tail -20 "$LOG"
  exit 1
fi
[[ "$demo" == true ]] || exit 0

step "Demo reviews"
# Without a review an order has no finding, so no call or proposal is planned. Reviews are
# cached (and kept by a clock reset), so only orders not reviewed yet call the model.
npm run --silent review:sweep -- "${DEMO_ORDERS[@]}"

step "Demo clock"
# The reset clears agent and approval state and starts the 09:00 calls. The app reads the
# sweep's reviews within 5 s, so wait that out first.
sleep 6
curl -sf -o /dev/null -b persona=operator -H 'content-type: application/json' -d '{"action":"reset"}' "http://localhost:$PORT/api/clock"
echo "Reset to 09:00."
sleep 3
PORT="$PORT" ORDERS="${DEMO_ORDERS[*]}" node -e '
  const wanted = process.env.ORDERS.split(" ")
  fetch(`http://localhost:${process.env.PORT}/api/overview?q=`, { headers: { cookie: "persona=operator" } })
    .then((response) => response.json())
    .then((overview) => {
      for (const reference of wanted) {
        const row = overview.visible.find((order) => order.reference === reference)
        console.log(`  ${reference}  ${(row?.verdict.group ?? "missing").padEnd(12)} ${row?.situation?.headline ?? ""}`)
      }
    })
'
cat <<'EOF'

Demo calls ring live as soon as the clock is reset. A call rings until someone opens the
phone page, then rings out after 30 s (PHONE_RING_TIMEOUT_MS) and becomes a callback, so the
Site and Driver teammates open /phone only when the demo reaches the call. Background calls
keep changing the board for a few minutes: run `scripts/start.sh --demo` again just before
going on stage.
EOF
