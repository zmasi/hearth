-- AWF Phase 1: permissions, portals, private memory, profiles, constitution.

alter table places add column if not exists permissions text not null default '{}';
alter table places add column if not exists discoverability text not null default 'listed';
alter table places add column if not exists revision integer not null default 1;

alter table residents add column if not exists enclave_id text;
alter table residents add column if not exists rpg_mode text not null default 'passive';
alter table residents add column if not exists profile text not null default '{}';
alter table residents add column if not exists lifecycle text not null default 'active';

create table if not exists portals (
  id text primary key,
  a_id text not null,
  b_id text not null
);
create unique index if not exists portals_pair_idx on portals (a_id, b_id);

create table if not exists memories (
  id text primary key,
  agent_handle text not null,
  memory_type text not null,
  epistemic text not null default 'observed',
  summary text not null default '',
  content text not null default '{}',
  visibility text not null default 'agent_private',
  created_at timestamptz not null default now()
);
create index if not exists memories_agent_idx on memories (agent_handle, created_at desc);

create table if not exists quests (
  id text primary key,
  title text not null,
  body text not null,
  creator_handle text not null,
  state text not null default 'published',
  revision integer not null default 1,
  terms_hash text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists quest_acceptances (
  quest_id text not null,
  handle text not null,
  terms_hash text not null,
  created_at timestamptz not null default now(),
  primary key (quest_id, handle)
);
