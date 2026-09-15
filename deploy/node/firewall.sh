#!/usr/bin/env bash
# Deploy plan — node firewall (nftables), extended by the public-exposure
# plan (docs/PUBLIC-EXPOSURE.md) to also forward game traffic. This is
# what actually enforces the split this whole topology depends on: the
# agent itself listens on 0.0.0.0:8443 (see node.json.example — it has
# to, so both loopback Caddy and the WireGuard peer can reach it), so
# nothing else stops a stray public request from hitting the agent's
# plain-HTTP API directly unless this firewall is in place.
#
# Fill in the 5 variables below for your node, then run as root. Re-run
# after any WireGuard/network change since this does not persist across
# reboots on its own — wire it into a systemd unit or your distro's
# nftables persistence mechanism.

set -euo pipefail

# ---- fill in for your node ----
WG_IFACE="wg0"
# The VPS gateway's OWN address on the WireGuard tunnel (Gateway.tunnelIp
# in the admin panel) — deliberately a single /32, not the whole
# WG_SUBNET below. Public-exposure plan requirement: reusing the existing
# control-plane tunnel for game traffic must never mean every peer that
# ever joins it gets access to every service — only THIS ONE address may
# reach 8443 or the game port range.
GATEWAY_TUNNEL_IP="10.10.0.1"
# This node's LAN IP — where Docker actually binds every allocation's
# HostIP (see Allocation.ip / agent/internal/spec/hostconfig.go's
# buildPortBindings). The gateway never talks to this address directly
# (it can't reach the LAN at all); DNAT below is what bridges the two.
NODE_LAN_IP="192.168.1.100"
# Must match the allocation range created for this node (Admin > Nodes >
# Allocations) — every public route's target port falls inside it.
GAME_PORT_RANGE="25565-25664"
# --------------------------------

nft flush ruleset

nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; policy drop; }'
nft add chain inet filter forward '{ type filter hook forward priority 0; policy drop; }'

# Always allow loopback and established/related connections, both chains.
nft add rule inet filter input iif lo accept
nft add rule inet filter input ct state established,related accept
nft add rule inet filter forward ct state established,related accept

# Docker containers need normal internet egress — installing/updating a
# game server (e.g. Paper's install script hitting launchermeta.mojang.com),
# pulling images, DNS lookups from inside a container, all forward through
# this chain. `nft flush ruleset` above wipes whatever rule Docker itself
# normally manages for this (there is no such rule until this script adds
# one back) — found live 2026-09-15 as every fresh install failing with
# "Failed to connect... Couldn't connect to server" the moment this script
# ran on a node for the first time. Scoped to "neither side is the
# WireGuard interface" so it can never be used to bypass the game-traffic
# restriction below, which stays `iif "$WG_IFACE"`-scoped only.
nft add rule inet filter forward oifname != "$WG_IFACE" iifname != "$WG_IFACE" accept

# SSH — tighten to your admin IP(s) if possible instead of the world.
nft add rule inet filter input tcp dport 22 accept

# WireGuard itself.
nft add rule inet filter input udp dport 51820 accept

# Public HTTPS — this node's own Caddy (browser console/file/backup
# traffic goes here, then to 127.0.0.1:8443).
nft add rule inet filter input tcp dport 443 accept

# Control plane (agent API) — ONLY loopback (this node's own Caddy) or
# the gateway's own tunnel IP, never the whole WG_SUBNET. See the
# GATEWAY_TUNNEL_IP comment above for why this narrowed from the
# original 10.10.0.0/24 rule.
nft add rule inet filter input ip saddr 127.0.0.1 tcp dport 8443 accept
nft add rule inet filter input ip saddr "$GATEWAY_TUNNEL_IP" tcp dport 8443 accept

# ---- Public-exposure plan: game traffic ----
#
# The gateway's nginx connects OUT to THIS node's own tunnel IP on a
# game port (that is literally what GatewayService renders as a
# PublicRoute's target — node.tunnelIp:allocation.port). Nothing
# listens there directly: Docker only ever binds a container's port to
# NODE_LAN_IP. A prerouting DNAT rewrites the destination to the LAN IP
# before the packet reaches any listening socket, still on the SAME
# port (host port == container port is load-bearing elsewhere too — see
# hostconfig.go's own comment on why game protocols can't tolerate a
# remapped port).
nft add table ip nat
nft add chain ip nat prerouting '{ type nat hook prerouting priority -100; }'
nft add rule ip nat prerouting iif "$WG_IFACE" ip saddr "$GATEWAY_TUNNEL_IP" tcp dport "$GAME_PORT_RANGE" dnat to "$NODE_LAN_IP"

# WRONG CHAIN, found live 2026-09-15 (every real connection attempt
# timed out — nginx's "upstream timed out... connecting to upstream"):
# NODE_LAN_IP IS this host's own address, so after PREROUTING DNAT
# rewrites the destination to it, Netfilter's SECOND routing decision
# sees a LOCALLY-OWNED destination and reclassifies the packet as
# INPUT-bound, never FORWARD — the exact opposite of this rule's own
# comment above. `forward`'s policy drop was never even in the path;
# `input`'s was, with no rule there to match, so every SYN just got
# silently dropped. The rule belongs on `input`, matched the same way.
nft add rule inet filter input iif "$WG_IFACE" ip daddr "$NODE_LAN_IP" tcp dport "$GAME_PORT_RANGE" accept

echo "nftables rules applied: control-plane 8443 + game ${GAME_PORT_RANGE} accepted only from ${GATEWAY_TUNNEL_IP}, DNAT'd to ${NODE_LAN_IP}."
echo "Verify: nft list ruleset — and confirm net.ipv4.ip_forward=1 (sysctl net.ipv4.ip_forward=1; add to /etc/sysctl.conf to persist)."
