ALTER TABLE work_items ADD COLUMN privacy_owner_member_id INTEGER;
--> statement-breakpoint
-- Only proven backing references with a known goal owner are reclassified.
UPDATE work_items SET privacy_owner_member_id = (
  SELECT g.owner_member_id FROM interventions i JOIN goals g ON g.id = i.goal_id
  WHERE i.backing_task_id = work_items.id AND g.owner_member_id IS NOT NULL
), scope = COALESCE((
  SELECT CASE WHEN g.area = 'work' THEN 'work' ELSE 'household' END
  FROM interventions i JOIN goals g ON g.id = i.goal_id
  WHERE i.backing_task_id = work_items.id AND g.owner_member_id IS NOT NULL
), scope)
WHERE id IN (SELECT backing_task_id FROM interventions WHERE backing_task_id IS NOT NULL);
--> statement-breakpoint
-- Privacy is sticky through moves and role conversion. Descendants inherit it,
-- including children created by existing canonical task commands.
CREATE TRIGGER work_items_inherit_privacy_insert AFTER INSERT ON work_items
WHEN NEW.parent_id IS NOT NULL AND (SELECT privacy_owner_member_id FROM work_items WHERE id = NEW.parent_id) IS NOT NULL
BEGIN
  UPDATE work_items SET privacy_owner_member_id = (SELECT privacy_owner_member_id FROM work_items WHERE id = NEW.parent_id) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_items_inherit_privacy_move AFTER UPDATE OF parent_id ON work_items
WHEN NEW.parent_id IS NOT NULL AND (SELECT privacy_owner_member_id FROM work_items WHERE id = NEW.parent_id) IS NOT NULL
BEGIN
  UPDATE work_items SET privacy_owner_member_id = (SELECT privacy_owner_member_id FROM work_items WHERE id = NEW.parent_id) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER work_items_preserve_privacy BEFORE UPDATE OF privacy_owner_member_id ON work_items
WHEN OLD.privacy_owner_member_id IS NOT NULL AND NEW.privacy_owner_member_id IS NOT OLD.privacy_owner_member_id
BEGIN
  SELECT RAISE(ABORT, 'Private work cannot be reassigned to another privacy owner');
END;
--> statement-breakpoint
CREATE TRIGGER work_items_cascade_privacy AFTER UPDATE OF privacy_owner_member_id ON work_items
WHEN NEW.privacy_owner_member_id IS NOT NULL
BEGIN
  UPDATE work_items SET privacy_owner_member_id = NEW.privacy_owner_member_id
  WHERE id IN (WITH RECURSIVE descendants(id) AS (
    SELECT id FROM work_items WHERE parent_id = NEW.id
    UNION ALL SELECT w.id FROM work_items w JOIN descendants d ON w.parent_id = d.id
  ) SELECT id FROM descendants);
END;
--> statement-breakpoint
-- Existing backing subtrees also inherit the proven owner and area placement.
WITH RECURSIVE private_tree(id, owner, scope) AS (
  SELECT id, privacy_owner_member_id, scope FROM work_items WHERE privacy_owner_member_id IS NOT NULL
  UNION ALL SELECT w.id, p.owner, p.scope FROM work_items w JOIN private_tree p ON w.parent_id = p.id
)
UPDATE work_items SET privacy_owner_member_id = (SELECT owner FROM private_tree WHERE id = work_items.id),
  scope = (SELECT scope FROM private_tree WHERE id = work_items.id)
WHERE id IN (SELECT id FROM private_tree);
--> statement-breakpoint
-- Historical activity must remain private even after subsequent task deletion.
UPDATE activity_events SET metadata = json_set(COALESCE(metadata, '{}'), '$.after.privacyOwnerMemberId',
  (SELECT privacy_owner_member_id FROM work_items WHERE id = activity_events.entity_id))
WHERE entity_id IN (SELECT id FROM work_items WHERE privacy_owner_member_id IS NOT NULL);
