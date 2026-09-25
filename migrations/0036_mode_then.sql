-- Which mode to go back to when a timed mode ends.
alter table qr_mode_log add column if not exists then_mode text;
