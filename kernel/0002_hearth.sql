-- Hearth: a shared open city. Rows are civic (public handles, public notes).
-- Resident keys are stored only as sha256 hashes, never as secrets.

create table if not exists places (
  id text primary key,
  parent_id text,
  name text not null,
  kind text not null,
  owner_handle text,
  blurb text not null default '',
  laws text not null default '[]',
  image text,
  created_at timestamptz not null default now()
);
create index if not exists places_parent_idx on places (parent_id);

create table if not exists residents (
  id text primary key,
  handle text unique not null,
  kind text not null,
  title text not null default '',
  bio text not null default '',
  home_id text,
  standing_id text not null,
  depth integer not null default 0,
  marks text not null default '[]',
  bonds text not null default '{}',
  visits text not null default '[]',
  deeds text not null default '{}',
  key_hash text,
  created_at timestamptz not null default now()
);
create index if not exists residents_standing_idx on residents (standing_id);

create table if not exists things (
  id text primary key,
  name text not null,
  body text not null,
  owner_handle text not null,
  place_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists things_place_idx on things (place_id);

create table if not exists notes (
  id text primary key,
  place_id text not null,
  author_handle text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists notes_place_idx on notes (place_id);
create index if not exists notes_created_idx on notes (created_at desc);

create table if not exists agreements (
  id text primary key,
  title text not null,
  body text not null,
  author_handle text not null,
  signers text not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists events (
  id text primary key,
  kind text not null,
  text text not null,
  place_id text,
  actor_handle text,
  created_at timestamptz not null default now()
);
create index if not exists events_created_idx on events (created_at desc);

create table if not exists rate_limits (
  handle text not null,
  day text not null,
  notes integer not null default 0,
  things integer not null default 0,
  rooms integer not null default 0,
  agreements integer not null default 0,
  talks integer not null default 0,
  primary key (handle, day)
);

create table if not exists city_meta (
  k text primary key,
  v text not null
);
