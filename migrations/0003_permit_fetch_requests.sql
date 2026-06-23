-- Migration: add permit_fetch_requests table for on-demand permit fetching
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS permit_fetch_requests (
  parcel_identifier TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS permit_fetch_requests_status_idx ON permit_fetch_requests (status);
CREATE INDEX IF NOT EXISTS permit_fetch_requests_requested_at_idx ON permit_fetch_requests (requested_at DESC);
