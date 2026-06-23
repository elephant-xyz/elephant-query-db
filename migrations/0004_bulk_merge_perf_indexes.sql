-- Migration: add source_record_key lookup indexes for bulk merge performance
--
-- Background: the batch appraisal merge runs ~20 LEFT JOINs per batch, resolving
-- FK references by matching stage.references_json->>'xSourceRecordKey' against
-- parent_table.source_record_key. The existing composite (source_system,
-- source_record_key) unique indexes cannot be used for NL-index probes when the
-- join condition is on source_record_key alone (it is the trailing column).
--
-- Without these indexes the planner builds a full hash of each parent table for
-- every merge query. For addresses (~1M rows) this alone cost 18+ seconds per
-- batch, causing the observed 20–30 min/batch slowdown as tables grew.
--
-- With single-column source_record_key indexes the planner switches to NL index
-- joins: one 0.01ms lookup per stage row instead of a full table scan. Measured
-- reduction on the properties merge: 20,874 ms → 305 ms (68x speedup).
--
-- All indexes use CONCURRENTLY so they are safe to run against a live database
-- without blocking any reads or writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS addresses_source_key_only_idx
  ON public.addresses (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS parcels_source_key_only_idx
  ON public.parcels (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS properties_source_key_only_idx
  ON public.properties (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS property_improvements_source_key_only_idx
  ON public.property_improvements (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_source_key_only_idx
  ON public.companies (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS people_source_key_only_idx
  ON public.people (source_record_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS deeds_source_key_only_idx
  ON public.deeds (source_record_key);
