-- Liveness of every upstream source the alert system depends on.
--
-- Motivation: both StonkFun feeds stopped returning data on 2026-09-03 and it
-- went unnoticed for two days. Nothing was broken in our code — the API simply
-- stopped answering production — and because a failed fetch was indistinguishable
-- from "nothing new", the outage was completely silent.
--
-- This records the outcome of an independent probe per source, so "the source is
-- unreachable" becomes an observable fact rather than an absence of alerts.
--
-- Note what is NOT stored here: when a feed last produced a RESULT. A source can
-- be perfectly healthy and produce nothing for weeks (the Robinhood registry adds
-- stocks rarely). Result-staleness would fire constant false alarms; fetch
-- success is the signal that actually distinguishes up from down.

create table if not exists feed_health (
  source text primary key,
  label text not null,
  chain text,
  -- Last time the probe got a usable response.
  last_ok_at timestamptz,
  -- Last time it failed, and why.
  last_fail_at timestamptz,
  last_error text,
  -- Resets to 0 on any success. Drives the "is it down" decision.
  consecutive_failures integer not null default 0,
  -- Whether a DOWN alert has already been sent, so recovery can be reported
  -- exactly once and the outage is not re-announced every pass.
  down_alerted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists feed_health_failures_idx
  on feed_health (consecutive_failures desc);
