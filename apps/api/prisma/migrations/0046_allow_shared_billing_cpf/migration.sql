-- A CPF identifies the payer, not an exclusive account owner. Family
-- members and users with multiple accounts may share billing details.
DROP INDEX IF EXISTS "users_cpf_uq";
