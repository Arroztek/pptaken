-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0007_trust_lineage: approvals bound to a trust lineage (ADR-024).
--
-- mode:              'owner' when the owner approved exactly approved_digest with a click; 'auto' when the server
--                    continued the owner's lineage for an edit of already-approved code (no new library).
-- owner_digest:      the last digest the owner approved with a click in this lineage (guest contexts only run it).
-- trusted_libs:      JSON array of "<sha256> <source>" keys of the libraries approved anywhere in the lineage.
-- previous_revision: for 'auto', the revision whose approved code the current one replaced ("Review changes").
-- Existing rows were all explicit owner approvals.

ALTER TABLE deck_scripts_approval ADD COLUMN mode TEXT NOT NULL DEFAULT 'owner' CHECK (mode IN ('owner', 'auto'));
ALTER TABLE deck_scripts_approval ADD COLUMN owner_digest TEXT;
ALTER TABLE deck_scripts_approval ADD COLUMN trusted_libs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deck_scripts_approval ADD COLUMN previous_revision INTEGER;

UPDATE deck_scripts_approval SET owner_digest = approved_digest WHERE owner_digest IS NULL;
