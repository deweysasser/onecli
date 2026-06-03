-- Per-agent override (null = inherit org default)
ALTER TABLE "agents" ADD COLUMN "policy_mode" TEXT;

-- New orgs default to locked-down; existing orgs already hold 'allow' from the
-- prior migration's default, so flipping the default does NOT change them.
ALTER TABLE "organizations" ALTER COLUMN "policy_mode" SET DEFAULT 'deny';
