-- Milestone M5: the panel needs to authenticate PANEL -> AGENT
-- control-plane calls (create server, power actions) with the same
-- secret issued to the agent as its node_token during M4's bootstrap
-- (node_tokens.token_hash is a one-way argon2id hash of it, sufficient
-- to verify AGENT -> PANEL calls but useless for the reverse direction).
-- This column holds an AES-256-GCM-encrypted, reversible copy of that
-- identical secret so the panel's AgentClient can decrypt-and-present it.
-- See the column's doc comment in schema.prisma for why this is a
-- deliberate interim simplification, not an oversight.
ALTER TABLE "nodes" ADD COLUMN "control_token_enc" BYTEA;
