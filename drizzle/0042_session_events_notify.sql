-- session_events: pg_notify on insert so the SSE stream can drop its 1.5s poll.
--
-- The trigger payload intentionally stays small (session_id + sequence + id).
-- The SSE handler uses the session_id to filter and then re-reads the row via
-- listEvents(sessionId, { afterSequence: lastSequence }) to preserve monotonic
-- ordering and idempotent dedup on sourceEventId. We don't ship the full row
-- in the NOTIFY payload because Postgres caps it at 8000 bytes and we don't
-- want to duplicate the JSONB blob on the wire.
--
-- Idempotent via DROP TRIGGER IF EXISTS + CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION notify_session_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'session_events',
    json_build_object(
      'sessionId', NEW.session_id,
      'sequence', NEW.sequence,
      'id', NEW.id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_events_notify ON session_events;

CREATE TRIGGER trg_session_events_notify
  AFTER INSERT ON session_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_session_event();
