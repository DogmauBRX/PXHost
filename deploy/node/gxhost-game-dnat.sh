#!/usr/bin/env bash
# Install with gxhost-game-dnat.service to keep the WireGuard -> Docker
# allocation DNAT alive across node reboots. This script owns only its
# dedicated nftables table and never flushes Docker's rules.

set -euo pipefail

: "${WG_IFACE:=wg0}"
: "${GATEWAY_TUNNEL_IP:?set GATEWAY_TUNNEL_IP in /etc/gxhost-agent/game-dnat.env}"
: "${NODE_LAN_IP:?set NODE_LAN_IP in /etc/gxhost-agent/game-dnat.env}"
: "${GAME_PORT_RANGE:?set GAME_PORT_RANGE in /etc/gxhost-agent/game-dnat.env}"

NFT_BIN="${NFT_BIN:-/usr/sbin/nft}"
TABLE="gxhost_gateway"

[[ "$WG_IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || { echo "invalid WG_IFACE" >&2; exit 2; }
[[ "$GATEWAY_TUNNEL_IP" =~ ^[0-9.]+$ ]] || { echo "invalid GATEWAY_TUNNEL_IP" >&2; exit 2; }
[[ "$NODE_LAN_IP" =~ ^[0-9.]+$ ]] || { echo "invalid NODE_LAN_IP" >&2; exit 2; }
[[ "$GAME_PORT_RANGE" =~ ^[0-9]+-[0-9]+$ ]] || { echo "invalid GAME_PORT_RANGE" >&2; exit 2; }

if "$NFT_BIN" list table ip "$TABLE" >/dev/null 2>&1; then
  "$NFT_BIN" delete table ip "$TABLE"
fi

"$NFT_BIN" add table ip "$TABLE"
"$NFT_BIN" "add chain ip $TABLE prerouting { type nat hook prerouting priority -101; policy accept; }"
"$NFT_BIN" add rule ip "$TABLE" prerouting \
  iifname "$WG_IFACE" \
  ip saddr "$GATEWAY_TUNNEL_IP" \
  tcp dport "$GAME_PORT_RANGE" \
  dnat to "$NODE_LAN_IP"

echo "GXhost game DNAT active: ${GATEWAY_TUNNEL_IP} -> ${NODE_LAN_IP}:${GAME_PORT_RANGE} via ${WG_IFACE}"
