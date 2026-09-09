#!/usr/bin/env bash
# Deploy plan — node firewall (nftables). This is what actually enforces
# the split this whole topology depends on: the agent itself listens on
# 0.0.0.0:8443 (see node.json.example — it has to, so both loopback
# Caddy and the WireGuard peer can reach it), so nothing else stops a
# stray public request from hitting the agent's plain-HTTP API directly
# unless this firewall is in place. Adjust the WireGuard subnet
# (10.10.0.0/24) and interface names (eth0/wg0) to match your actual
# setup before running. Run as root; re-run after any WireGuard/network
# change since this does not persist across reboots on its own — wire it
# into a systemd unit or your distro's nftables persistence mechanism.

set -euo pipefail

nft flush ruleset

nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; policy drop; }'

# Always allow loopback and established/related connections.
nft add rule inet filter input iif lo accept
nft add rule inet filter input ct state established,related accept

# SSH — tighten to your admin IP(s) if possible instead of the world.
nft add rule inet filter input tcp dport 22 accept

# WireGuard itself.
nft add rule inet filter input udp dport 51820 accept

# Public HTTPS — this node's own Caddy (browser console/file/backup
# traffic goes here, then to 127.0.0.1:8443).
nft add rule inet filter input tcp dport 443 accept

# The agent's control-plane port — ONLY from loopback (this node's own
# Caddy) or the WireGuard subnet (the VPS's AgentClientService calls via
# node.controlAddress). Never from the public interface directly.
nft add rule inet filter input ip saddr 127.0.0.1 tcp dport 8443 accept
nft add rule inet filter input ip saddr 10.10.0.0/24 tcp dport 8443 accept

echo "nftables rules applied. Verify: nft list ruleset"
