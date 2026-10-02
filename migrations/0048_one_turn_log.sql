-- 2026-10-02: one record per reply turn. brain_log (+ brain_log_raw) already had everything; brain_turns and
-- turn_traces repeated it. The few things only turn_traces kept (which moments came back and how they were found)
-- move into brain_log.refs, then both tables go.
update brain_log l
set refs = coalesce(l.refs, '{}'::jsonb)
  || jsonb_strip_nulls(jsonb_build_object(
       'recalled', t.retrieve->'texts',
       'recallBy', t.retrieve->'by',
       'personaPlacement', t.live->'personaPlacement'))
from turn_traces t
where l.route = 'voice' and l.output_ref = 'message:' || t.turn_id
  and jsonb_typeof(t.retrieve) = 'object';

drop table if exists turn_traces;
drop table if exists brain_turns;

create index if not exists brain_log_output_ref_idx on brain_log (output_ref);
