-- Server-to-server API (see docs/crm-api.md).
--
-- external_id: the caller's own id for the envelope, such as a CRM lead.
-- callback_url: where status changes are reported. Null when nobody is listening.
-- message: an optional note added to the signing invitation. Null on envelopes
-- created in the app, whose invitations stay as they were.
-- webhook_deliveries: one row per callback attempt series, so a missed
-- delivery can be seen without reading the function logs.

alter table public.envelopes
  add column if not exists external_id text,
  add column if not exists callback_url text,
  add column if not exists message text;

alter table public.envelopes
  drop constraint if exists envelopes_external_id_length;

alter table public.envelopes
  add constraint envelopes_external_id_length
    check (external_id is null or char_length(external_id) <= 200);

alter table public.envelopes
  drop constraint if exists envelopes_callback_url_length;

alter table public.envelopes
  add constraint envelopes_callback_url_length
    check (callback_url is null or char_length(callback_url) <= 2000);

alter table public.envelopes
  drop constraint if exists envelopes_message_length;

alter table public.envelopes
  add constraint envelopes_message_length
    check (message is null or char_length(message) <= 2000);

create index if not exists idx_envelopes_external_id
  on public.envelopes (external_id)
  where external_id is not null;

create table if not exists public.webhook_deliveries (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  event text not null,
  callback_url text not null,
  payload jsonb not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  status text not null check (status in ('pending', 'delivered', 'failed')),
  last_status_code integer,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null,
  delivered_at bigint
);

create index if not exists idx_webhook_deliveries_envelope
  on public.webhook_deliveries (envelope_id, created_at);
