-- Fixes a real double-ingestion race on public.leads.
-- Run this once in the Supabase SQL editor. Safe to re-run: idempotent.
--
-- GET /api/leads/pending is polled every 30s and on window focus. If two
-- polls race (two open CRM tabs/devices, or a slow POST /api/leads/ack that
-- hasn't landed yet), both could fetch the same still-unacked lead and both
-- ingest it into the CRM as a separate record. The frontend's dedup guard
-- (matching payload.submittedAt against already-loaded records) only
-- protects a single already-loaded session, not two concurrent pollers.
--
-- Fix: getPendingLeads() now atomically claims rows via a single UPDATE
-- (only unacked rows not claimed within the last 60s), instead of a plain
-- SELECT — so a second concurrent poll can no longer see a lead the first
-- poll just claimed. If the first poll's ack never arrives (crash, network),
-- the claim expires after 60s and the lead becomes pollable again rather
-- than being lost.

alter table public.leads add column if not exists claimed_at timestamptz;
