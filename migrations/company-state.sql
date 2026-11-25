-- Run with the Slack worker stopped and its historical owner verified.
-- SET LOCAL slack_socket.company_id to the operator-confirmed UUID in the same transaction.
-- For rollback also SET LOCAL slack_socket.rollback = 'on'.
DO $migration$
DECLARE
  owner_id uuid := current_setting('slack_socket.company_id')::uuid;
  rollback_scope boolean := coalesce(nullif(current_setting('slack_socket.rollback', true), ''), 'off')::boolean;
  installed_id uuid;
  configured_id uuid;
  configured_value text;
  moved bigint;
BEGIN
  SELECT id INTO STRICT installed_id FROM plugins WHERE plugin_key = 'cvh.slack-socket';
  SELECT company_id, config_json->>'companyId' INTO STRICT configured_id, configured_value
    FROM plugin_config WHERE plugin_id = installed_id FOR SHARE;
  IF configured_id IS DISTINCT FROM owner_id OR configured_value IS DISTINCT FROM owner_id::text THEN
    RAISE EXCEPTION 'Saved Slack company differs from the confirmed historical owner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM plugin_state
    WHERE plugin_id = installed_id AND namespace = 'slack-socket'
      AND ((scope_kind = 'company' AND scope_id IS DISTINCT FROM owner_id::text)
        OR (scope_kind = 'instance' AND scope_id IS NOT NULL)
        OR (scope_kind IN ('instance', 'company') AND value_json ? 'companyId'
            AND value_json->>'companyId' IS DISTINCT FROM owner_id::text))
  ) THEN
    RAISE EXCEPTION 'Found Slack state with conflicting ownership';
  END IF;

  -- Move rows in place. The unique constraint rejects a colliding key atomically.
  UPDATE plugin_state
     SET scope_kind = CASE WHEN rollback_scope THEN 'instance' ELSE 'company' END,
         scope_id = CASE WHEN rollback_scope THEN NULL ELSE owner_id::text END
   WHERE plugin_id = installed_id AND namespace = 'slack-socket'
     AND ((rollback_scope AND scope_kind = 'company' AND scope_id = owner_id::text)
       OR (NOT rollback_scope AND scope_kind = 'instance' AND scope_id IS NULL));
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'Moved % Slack state rows', moved;
END;
$migration$;
