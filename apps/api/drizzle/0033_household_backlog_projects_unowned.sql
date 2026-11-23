-- Household projects parked in the backlog do not have a responsible person.
-- Work-scope projects retain their owner because ownership also governs access.
-- Inherited task responsibility intentionally resolves to null while parked and returns from the hierarchy on activation; explicit task assignments remain untouched.
UPDATE work_items
SET owner_member_id = NULL,
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role = 'story'
  AND status = 'backlog'
  AND archived_at IS NULL
  AND scope = 'household'
  AND owner_member_id IS NOT NULL;
