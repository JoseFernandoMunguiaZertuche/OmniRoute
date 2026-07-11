#!/bin/bash
# keep-omniroute-alive.sh — watchdog for omniroute container
# Called by keep-omniroute-alive.timer every 10s

CONTAINER=omniroute
IMAGE=omniroute:base
NETWORK_CONTAINER=gluetun
LAST_LOG_FILE=/tmp/keep-omniroute-last.log

log() { logger -t keep-omniroute "$*" 2>/dev/null || echo "[$(date +%H:%M:%S)] $*" >&2; }

# === Capture last omniroute logs for forensics on death ===
capture_last_logs() {
  docker logs --tail 50 "$CONTAINER" > "$LAST_LOG_FILE" 2>&1 || true
  log "captured last 50 lines to $LAST_LOG_FILE"
}

# === If gluetun missing, start it ===
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$NETWORK_CONTAINER"; then
  log "gluetun not running — starting it"
  if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$NETWORK_CONTAINER"; then
    docker rm -f "$NETWORK_CONTAINER" 2>/dev/null || true
    docker run -d --name "$NETWORK_CONTAINER" --cap-add=NET_ADMIN \
      --device=/dev/net/tun:/dev/net/tun \
      -v /home/jferm/OmniRoute/scripts/vpn/wg0.conf:/gluetun/wireguard/wg0.conf:ro \
      -e VPN_SERVICE_PROVIDER=custom -e VPN_TYPE=wireguard \
      -e WIREGUARD_IMPLEMENTATION=userspace \
      -e HTTP_CONTROL_SERVER_ADDRESS=0.0.0.0:8000 \
      -p 127.0.0.1:8000:8000 \
      -p 127.0.0.1:20128:20128 \
      -p 127.0.0.1:20129:20129 \
      --restart unless-stopped \
      qmcgaw/gluetun:v3
  else
    docker start "$NETWORK_CONTAINER" 2>/dev/null || true
  fi
  sleep 15
fi

# === Check if omniroute was previously running but died ===
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
    # Container exists but is NOT running → it died. Capture forensics.
    EXIT_CODE=$(docker inspect "$CONTAINER" --format='{{.State.ExitCode}}' 2>/dev/null || echo "unknown")
    ERROR=$(docker inspect "$CONTAINER" --format='{{.State.Error}}' 2>/dev/null)
    OOM=$(docker inspect "$CONTAINER" --format='{{.State.OOMKilled}}' 2>/dev/null)
    log "DEAD: exit=$EXIT_CODE error=$ERROR oomKilled=$OOM"

    # Capture last 50 log lines BEFORE removing
    capture_last_logs

    # Snapshot full state for diagnosis
    docker inspect "$CONTAINER" > "/tmp/keep-omniroute-${CONTAINER}.inspect.json" 2>&1 || true

    # Also check kernel for OOM
    if [ "$OOM" = "true" ] || [ "$EXIT_CODE" = "137" ]; then
      log "  → OOM kill suspected. Recent kernel events:"
      sudo dmesg --since "5m ago" 2>/dev/null | grep -iE "killed|oom|memory" | tail -5 | while read -r line; do
        log "    $line"
      done
    fi
  fi
fi

# === If omniroute is missing or dead, start it ===
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  log "omniroute not running — starting it"
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker run -d --name "$CONTAINER" --network container:gluetun \
    --restart always \
    -e NODE_ENV=production \
    -e PORT=20128 -e DASHBOARD_PORT=20128 -e API_PORT=20129 \
    -e LIVE_WS_PORT=20133 \
    -e DATA_DIR=/app/data \
    -e OMNIROUTE_VPN_API_URL=http://127.0.0.1:8000 \
    -e OMNIROUTE_VPN_ROTATE_ON_FAILOVER=1 \
    -e OMNIROUTE_VPN_COOLDOWN_MS=5000 \
    -e OMNIROUTE_VPN_ROTATE_TIMEOUT_MS=25000 \
    -e OMNIROUTE_VPN_RECONNECT_GAP_MS=2000 \
    -v /home/jferm/OmniRoute/.env:/app/.env:ro \
    -v /home/jferm/OmniRoute/data:/app/data \
    "$IMAGE"
  PID=$(docker inspect --format='{{.State.Pid}}' "$CONTAINER" 2>/dev/null)
  log "omniroute restarted (PID=$PID)"
fi

exit 0
