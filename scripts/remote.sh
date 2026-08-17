#!/usr/bin/env bash
# Bench Studio — remote access, in one command.
#
#   ./scripts/remote.sh open      publish the studio on this machine's IP
#   ./scripts/remote.sh close     put it back on loopback only
#   ./scripts/remote.sh status    is it open? on which port? with a password?
#
# What `open` touches, and nothing else:
#   .env                BENCH_WEB_HOST=0.0.0.0  (interface listens on every NIC)
#                       BENCH_API_HOST=127.0.0.1 (API stays private, on purpose)
#   ufw                 allow OpenSSH, then allow <web port>/tcp
#   data/remote.state   what was changed, so `close` undoes exactly that
#
# `close` reads that state file and reverses it. Running either twice is safe.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
STATE_DIR="$ROOT/data"
STATE_FILE="$STATE_DIR/remote.state"

RESTRICT_IP=""
ENABLE_FIREWALL=0

# ------------------------------------------------------------------ helpers

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗  %s\033[0m\n' "$*" >&2; exit 1; }

# ufw needs root. Asking for sudo only when a ufw call is actually made keeps
# `status` usable without a password prompt.
sudo_if_needed() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

has_ufw() { command -v ufw >/dev/null 2>&1; }

ufw_active() {
  has_ufw && sudo_if_needed ufw status 2>/dev/null | head -1 | grep -qi "Status: active"
}

env_get() {
  # Last assignment wins, matching how the studio reads the file.
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

env_set() {
  local key="$1" value="$2"
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # A temp file plus mv keeps the .env intact if the machine dies mid-write.
    local tmp="$ENV_FILE.tmp.$$"
    awk -v k="$key" -v v="$value" '
      $0 ~ "^" k "=" { if (!done) { print k "=" v; done = 1 }; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

web_port() {
  local p
  p="$(env_get BENCH_WEB_PORT)"
  printf '%s' "${p:-5200}"
}

public_ip() {
  local ip
  ip="$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "${ip:-<this-machine-ip>}"
}

listening_on() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $4}' | paste -sd' ' -
  fi
}

# Offers, does not impose: pressing Enter opens the studio without a password,
# which is the documented default. The offer exists because afterwards the only
# way in is back to this machine.
offer_password() {
  [ -z "$(env_get BENCH_PASSWORD)" ] || return 0
  if [ ! -t 0 ]; then
    warn "no password set, and no terminal to ask on. Run: npm run set-password"
    return 0
  fi

  echo
  warn "No password: whoever reaches the address gets in — that is the default."
  echo "   Now is the cheap moment to set one: from the network it cannot be done at all."
  local answer
  printf '   Set a password now? [Y/n] '
  read -r answer
  case "$answer" in
    [Nn]*) warn "skipped — set it later with: npm run set-password"; return 0 ;;
  esac

  # Delegates to the real command instead of reimplementing it here: it asks
  # twice, echoes nothing, and never lets the password through an argument or
  # the shell history.
  if (cd "$ROOT" && npm run --silent set-password); then
    ok "password set — it is in effect for the studio's next start"
  else
    warn "not set — run it yourself when you want: npm run set-password"
  fi
}

# ------------------------------------------------------------------ open

cmd_open() {
  local port; port="$(web_port)"
  local previous_host; previous_host="$(env_get BENCH_WEB_HOST)"
  local rule_added=0

  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ROOT/.env.example" ]; then cp "$ROOT/.env.example" "$ENV_FILE"; else : > "$ENV_FILE"; fi
    warn "no .env found — created one. Add your provider keys later, from the Config screen."
  fi

  # The password can only be set from this machine — and this script IS on the
  # machine. Asking here is the one moment the answer is cheap: once the port is
  # open, the person on the other end cannot set it themselves, by design.
  offer_password

  env_set BENCH_WEB_HOST 0.0.0.0
  # Explicit, not implied: the API is the part that writes files and spends
  # money. Only the interface goes out; the API answers the interface only.
  env_set BENCH_API_HOST 127.0.0.1
  ok "interface set to listen on every interface, API kept on loopback"

  if has_ufw; then
    sudo_if_needed ufw allow OpenSSH >/dev/null 2>&1 || warn "could not add the OpenSSH rule — check ufw by hand before enabling it"
    if [ -n "$RESTRICT_IP" ]; then
      sudo_if_needed ufw allow from "$RESTRICT_IP" to any port "$port" proto tcp >/dev/null
      ok "firewall: port $port open to $RESTRICT_IP only"
    else
      sudo_if_needed ufw allow "$port/tcp" >/dev/null
      ok "firewall: port $port open to everyone"
    fi
    rule_added=1

    if ! ufw_active; then
      if [ "$ENABLE_FIREWALL" -eq 1 ]; then
        sudo_if_needed ufw --force enable >/dev/null
        ok "firewall enabled (SSH allowed first, so this session stays up)"
      else
        warn "ufw is installed but INACTIVE — every other port on this machine is open too."
        warn "to turn it on with SSH and this port already allowed: ./scripts/remote.sh open --firewall"
      fi
    fi
  else
    warn "ufw not installed — nothing filters this machine's ports. Check your VPS provider's firewall panel."
  fi

  mkdir -p "$STATE_DIR"
  {
    echo "port=$port"
    echo "previous_web_host=$previous_host"
    echo "rule_added=$rule_added"
    echo "restrict_ip=$RESTRICT_IP"
    echo "opened_at=$(date -Iseconds)"
  } > "$STATE_FILE"

  echo
  bold "Studio reachable at:  http://$(public_ip):$port"
  echo
  if [ -z "$(env_get BENCH_PASSWORD)" ]; then
    warn "NO PASSWORD: anyone who reaches that address is in. That is the default."
    echo "   Set one now, then restart:   npm run set-password"
  else
    ok "password is set — the API asks for it"
  fi
  warn "plain HTTP: the traffic is readable in transit. Fine for a test, not for production."
  echo
  echo "Restart the studio so the change takes effect:   npm run dev"
  bold "When you are done:   ./scripts/remote.sh close"
}

# ------------------------------------------------------------------ close

cmd_close() {
  local port previous_host rule_added restrict_ip
  port="$(web_port)"; previous_host=""; rule_added=0; restrict_ip=""

  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    while IFS='=' read -r k v; do
      case "$k" in
        port) port="$v" ;;
        previous_web_host) previous_host="$v" ;;
        rule_added) rule_added="$v" ;;
        restrict_ip) restrict_ip="$v" ;;
      esac
    done < "$STATE_FILE"
  else
    warn "no state file — closing with the defaults (port $port)."
  fi

  # An empty previous value means "was never exposed": back to the factory
  # default rather than writing an empty variable the studio would ignore.
  env_set BENCH_WEB_HOST "${previous_host:-127.0.0.1}"
  env_set BENCH_API_HOST 127.0.0.1
  ok "interface back on loopback (BENCH_WEB_HOST=${previous_host:-127.0.0.1})"

  if has_ufw && [ "$rule_added" = "1" ]; then
    if [ -n "$restrict_ip" ]; then
      sudo_if_needed ufw delete allow from "$restrict_ip" to any port "$port" proto tcp >/dev/null 2>&1 || true
    else
      sudo_if_needed ufw delete allow "$port/tcp" >/dev/null 2>&1 || true
    fi
    ok "firewall rule for port $port removed"
  fi
  # The OpenSSH rule is deliberately left in place: removing it is how people
  # lock themselves out of their own server.

  rm -f "$STATE_FILE"

  echo
  echo "Restart the studio to drop the open socket:   npm run dev"
  local still; still="$(listening_on "$port")"
  if [ -n "$still" ] && printf '%s' "$still" | grep -q '0.0.0.0\|\*:'; then
    warn "port $port is STILL listening on $still — that is the old process. Restart it."
  fi
}

# ------------------------------------------------------------------ status

cmd_status() {
  local port; port="$(web_port)"
  local host; host="$(env_get BENCH_WEB_HOST)"
  local listening; listening="$(listening_on "$port")"

  if [ -f "$STATE_FILE" ]; then
    bold "OPEN — since $(grep '^opened_at=' "$STATE_FILE" | cut -d= -f2-)"
    echo "   address:  http://$(public_ip):$port"
  else
    bold "CLOSED — local access only"
  fi
  echo "   BENCH_WEB_HOST:  ${host:-127.0.0.1 (default)}"
  echo "   BENCH_API_HOST:  $(env_get BENCH_API_HOST) (empty means 127.0.0.1)"
  echo "   listening on:    ${listening:-nothing on port $port}"
  if [ -z "$(env_get BENCH_PASSWORD)" ]; then
    echo "   password:        not set — no login required"
  else
    echo "   password:        set"
  fi
  if has_ufw; then
    if ufw_active; then echo "   firewall:        ufw active"; else echo "   firewall:        ufw installed but INACTIVE"; fi
  else
    echo "   firewall:        ufw not installed"
  fi
}

# ------------------------------------------------------------------ main

COMMAND="${1:-}"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) RESTRICT_IP="${2:-}"; shift 2 ;;
    --firewall) ENABLE_FIREWALL=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$COMMAND" in
  open|abrir)    cmd_open ;;
  close|fechar)  cmd_close ;;
  status)        cmd_status ;;
  *)
    cat <<'USAGE'
Bench Studio — remote access

  ./scripts/remote.sh open                 publish the interface on this machine's IP
  ./scripts/remote.sh open --ip 203.0.113.7   ...but only to that address
  ./scripts/remote.sh open --firewall      also turn ufw on (SSH allowed first)
  ./scripts/remote.sh close                back to local access only
  ./scripts/remote.sh status               open or closed, and with what protection

The studio ships with no password. `open` says so, and does not stop:
set one with `npm run set-password` whenever you want.
USAGE
    exit 1 ;;
esac
