-- Household projects parked in the backlog do not have a responsible person.
-- Work-scope projects retain their owner because ownership also governs access.
UPDATE work_items
SET owner_member_id = NULL,
    revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role = 'story'
  AND status = 'backlog'
  AND archived_at IS NULL
  AND scope = 'household'
  AND owner_member_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER household_backlog_projects_unowned_insert
BEFORE INSERT ON work_items
WHEN NEW.role = 'story'
  AND NEW.status = 'backlog'
  AND NEW.archived_at IS NULL
  AND NEW.scope = 'household'
  AND NEW.owner_member_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'household_backlog_project_owner_forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER household_backlog_projects_unowned_update
BEFORE UPDATE OF role, status, archived_at, scope, owner_member_id ON work_items
WHEN NEW.role = 'story'
  AND NEW.status = 'backlog'
  AND NEW.archived_at IS NULL
  AND NEW.scope = 'household'
  AND NEW.owner_member_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'household_backlog_project_owner_forbidden');
END;
