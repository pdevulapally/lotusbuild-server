--
-- PostgreSQL database dump
--

\restrict aeu7ucEZ2E4CSOfbzgLBuYK4Dpge5ltvQtcuAiV42joJzAV5ytKz7tvenwsoltR

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: build_session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.build_session_status AS ENUM (
    'QUEUED',
    'RUNNING',
    'IDLE',
    'FAILED'
);


--
-- Name: entitlement_value_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entitlement_value_kind AS ENUM (
    'boolean',
    'number',
    'string',
    'stringList'
);


--
-- Name: idempotency_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idempotency_status AS ENUM (
    'IN_PROGRESS',
    'COMPLETED'
);


--
-- Name: merge_strategy; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.merge_strategy AS ENUM (
    'OVERRIDE',
    'ADD',
    'MAX',
    'MIN',
    'UNION',
    'INTERSECTION',
    'HARD_DENY'
);


--
-- Name: meter_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.meter_kind AS ENUM (
    'COUNTER',
    'GAUGE'
);


--
-- Name: plan_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.plan_status AS ENUM (
    'ACTIVE',
    'DEPRECATED'
);


--
-- Name: project_platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_platform AS ENUM (
    'mobile',
    'web'
);


--
-- Name: project_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_status AS ENUM (
    'draft'
);


--
-- Name: rate_limit_class; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.rate_limit_class AS ENUM (
    'read',
    'write',
    'build',
    'stream'
);


--
-- Name: reservation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reservation_status AS ENUM (
    'OPEN',
    'SETTLED',
    'RELEASED'
);


--
-- Name: reset_period; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reset_period AS ENUM (
    'NEVER',
    'DAILY',
    'MONTHLY'
);


--
-- Name: sandbox_provider_key; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_provider_key AS ENUM (
    'vps',
    'e2b'
);


--
-- Name: sandbox_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.sandbox_status AS ENUM (
    'STARTING',
    'RUNNING',
    'STOPPED',
    'FAILED'
);


--
-- Name: subscription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_status AS ENUM (
    'TRIALING',
    'ACTIVE',
    'PAST_DUE',
    'CANCELED',
    'INCOMPLETE'
);


--
-- Name: usage_entry_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.usage_entry_type AS ENUM (
    'RESERVE',
    'SETTLE',
    'RELEASE',
    'ADJUSTMENT'
);


--
-- Name: usage_ledger_reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.usage_ledger_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lotusbuild.allow_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'usage_ledger is append-only: % is not permitted. Append an ADJUSTMENT entry, or authorise a purge with SET LOCAL lotusbuild.allow_ledger_purge = ''on''.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: build_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.build_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id text NOT NULL,
    sandbox_id uuid,
    status public.build_session_status DEFAULT 'QUEUED'::public.build_session_status NOT NULL,
    model text NOT NULL,
    effort text NOT NULL,
    claimed_by text,
    heartbeat_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capabilities (
    key text NOT NULL,
    value_kind public.entitlement_value_kind NOT NULL,
    merge_strategy public.merge_strategy NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text NOT NULL
);


--
-- Name: entitlement_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entitlement_sources (
    key text NOT NULL,
    precedence integer NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    user_id text NOT NULL,
    key text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    request_hash text NOT NULL,
    status public.idempotency_status DEFAULT 'IN_PROGRESS'::public.idempotency_status NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: meter_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meter_limits (
    plan_id uuid NOT NULL,
    meter_key text NOT NULL,
    included_allowance bigint NOT NULL,
    hard_limit bigint NOT NULL,
    overage_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_limits_allowance_within_hard_limit CHECK ((included_allowance <= hard_limit)),
    CONSTRAINT meter_limits_non_negative CHECK (((included_allowance >= 0) AND (hard_limit >= 0)))
);


--
-- Name: meter_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meter_usage (
    user_id text NOT NULL,
    meter_key text NOT NULL,
    consumed bigint DEFAULT 0 NOT NULL,
    reserved bigint DEFAULT 0 NOT NULL,
    period_start timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meter_usage_non_negative CHECK (((consumed >= 0) AND (reserved >= 0)))
);


--
-- Name: meters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meters (
    key text NOT NULL,
    unit text NOT NULL,
    kind public.meter_kind NOT NULL,
    reset_period public.reset_period NOT NULL,
    description text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text NOT NULL
);


--
-- Name: plan_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_entitlements (
    plan_id uuid NOT NULL,
    capability_key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    status public.plan_status DEFAULT 'ACTIVE'::public.plan_status NOT NULL,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_repositories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_repositories (
    project_id uuid NOT NULL,
    installation_id bigint NOT NULL,
    owner text NOT NULL,
    name text NOT NULL,
    repository_id bigint NOT NULL,
    default_branch text NOT NULL,
    protected_branches text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id text NOT NULL,
    name character varying(100) NOT NULL,
    description character varying(500),
    status public.project_status DEFAULT 'draft'::public.project_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    platform public.project_platform NOT NULL
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    plan_id uuid NOT NULL,
    route_class public.rate_limit_class NOT NULL,
    max_requests integer NOT NULL,
    window_seconds integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_limits_positive CHECK (((max_requests > 0) AND (window_seconds > 0)))
);


--
-- Name: sandbox_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_providers (
    platform public.project_platform NOT NULL,
    provider public.sandbox_provider_key NOT NULL,
    template text NOT NULL,
    timeout_seconds integer NOT NULL,
    memory_mb integer NOT NULL,
    cpus integer NOT NULL,
    concurrency_meter_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workdir text NOT NULL,
    idle_grace_seconds integer NOT NULL,
    agent_instructions text NOT NULL
);


--
-- Name: sandboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    user_id text NOT NULL,
    platform public.project_platform NOT NULL,
    provider public.sandbox_provider_key NOT NULL,
    external_id text,
    status public.sandbox_status DEFAULT 'STARTING'::public.sandbox_status NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    billed_seconds bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preview_url text,
    preview_port integer,
    preview_started_at timestamp with time zone,
    preview_device_url text
);


--
-- Name: session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    seq bigint NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    plan_id uuid NOT NULL,
    status public.subscription_status NOT NULL,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_period_ordered CHECK ((current_period_end > current_period_start))
);


--
-- Name: usage_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    meter_key text NOT NULL,
    type public.usage_entry_type NOT NULL,
    quantity bigint NOT NULL,
    consumed_after bigint NOT NULL,
    reservation_id uuid,
    operation_id text,
    description text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    meter_key text NOT NULL,
    estimated_quantity bigint NOT NULL,
    settled_quantity bigint,
    status public.reservation_status DEFAULT 'OPEN'::public.reservation_status NOT NULL,
    operation_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_reservations_estimate_positive CHECK ((estimated_quantity > 0)),
    CONSTRAINT usage_reservations_settled_within_estimate CHECK (((settled_quantity IS NULL) OR ((settled_quantity >= 0) AND (settled_quantity <= estimated_quantity))))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    uid text NOT NULL,
    email text NOT NULL,
    display_name text,
    photo_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: build_sessions build_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_sessions
    ADD CONSTRAINT build_sessions_pkey PRIMARY KEY (id);


--
-- Name: capabilities capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (key);


--
-- Name: entitlement_sources entitlement_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlement_sources
    ADD CONSTRAINT entitlement_sources_pkey PRIMARY KEY (key);


--
-- Name: idempotency_keys idempotency_keys_user_id_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_user_id_key_pk PRIMARY KEY (user_id, key);


--
-- Name: meter_limits meter_limits_plan_id_meter_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_limits
    ADD CONSTRAINT meter_limits_plan_id_meter_key_pk PRIMARY KEY (plan_id, meter_key);


--
-- Name: meter_usage meter_usage_user_id_meter_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_usage
    ADD CONSTRAINT meter_usage_user_id_meter_key_pk PRIMARY KEY (user_id, meter_key);


--
-- Name: meters meters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meters
    ADD CONSTRAINT meters_pkey PRIMARY KEY (key);


--
-- Name: plan_entitlements plan_entitlements_plan_id_capability_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_entitlements
    ADD CONSTRAINT plan_entitlements_plan_id_capability_key_pk PRIMARY KEY (plan_id, capability_key);


--
-- Name: plans plans_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_key_unique UNIQUE (key);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: project_repositories project_repositories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_pkey PRIMARY KEY (project_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_plan_id_route_class_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_plan_id_route_class_pk PRIMARY KEY (plan_id, route_class);


--
-- Name: sandbox_providers sandbox_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_providers
    ADD CONSTRAINT sandbox_providers_pkey PRIMARY KEY (platform);


--
-- Name: sandboxes sandboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandboxes
    ADD CONSTRAINT sandboxes_pkey PRIMARY KEY (id);


--
-- Name: session_events session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_events
    ADD CONSTRAINT session_events_pkey PRIMARY KEY (id);


--
-- Name: session_messages session_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_messages
    ADD CONSTRAINT session_messages_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: usage_ledger usage_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_ledger
    ADD CONSTRAINT usage_ledger_pkey PRIMARY KEY (id);


--
-- Name: usage_reservations usage_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (uid);


--
-- Name: build_sessions_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_sessions_project_idx ON public.build_sessions USING btree (project_id);


--
-- Name: build_sessions_queued_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_sessions_queued_idx ON public.build_sessions USING btree (created_at) WHERE (status = 'QUEUED'::public.build_session_status);


--
-- Name: build_sessions_running_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX build_sessions_running_heartbeat_idx ON public.build_sessions USING btree (heartbeat_at) WHERE (status = 'RUNNING'::public.build_session_status);


--
-- Name: entitlement_sources_precedence_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entitlement_sources_precedence_key ON public.entitlement_sources USING btree (precedence);


--
-- Name: idempotency_keys_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_expires_idx ON public.idempotency_keys USING btree (expires_at);


--
-- Name: projects_owner_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_owner_id_created_at_idx ON public.projects USING btree (owner_id, created_at DESC);


--
-- Name: sandboxes_external_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sandboxes_external_id_key ON public.sandboxes USING btree (provider, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: sandboxes_live_by_user_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandboxes_live_by_user_platform_idx ON public.sandboxes USING btree (user_id, platform) WHERE (status = ANY (ARRAY['STARTING'::public.sandbox_status, 'RUNNING'::public.sandbox_status]));


--
-- Name: sandboxes_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandboxes_project_idx ON public.sandboxes USING btree (project_id);


--
-- Name: session_events_session_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_events_session_seq_key ON public.session_events USING btree (session_id, seq);


--
-- Name: session_messages_session_seq_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_messages_session_seq_key ON public.session_messages USING btree (session_id, seq);


--
-- Name: subscriptions_one_live_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_one_live_per_user ON public.subscriptions USING btree (user_id) WHERE (status = ANY (ARRAY['TRIALING'::public.subscription_status, 'ACTIVE'::public.subscription_status]));


--
-- Name: usage_ledger_user_meter_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_ledger_user_meter_created_idx ON public.usage_ledger USING btree (user_id, meter_key, created_at);


--
-- Name: usage_reservations_one_open_per_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX usage_reservations_one_open_per_operation ON public.usage_reservations USING btree (operation_id) WHERE ((status = 'OPEN'::public.reservation_status) AND (operation_id IS NOT NULL));


--
-- Name: usage_reservations_open_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_reservations_open_created_idx ON public.usage_reservations USING btree (created_at) WHERE (status = 'OPEN'::public.reservation_status);


--
-- Name: usage_ledger usage_ledger_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_ledger_no_delete BEFORE DELETE ON public.usage_ledger FOR EACH ROW EXECUTE FUNCTION public.usage_ledger_reject_mutation();


--
-- Name: usage_ledger usage_ledger_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_ledger_no_update BEFORE UPDATE ON public.usage_ledger FOR EACH ROW EXECUTE FUNCTION public.usage_ledger_reject_mutation();


--
-- Name: build_sessions build_sessions_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_sessions
    ADD CONSTRAINT build_sessions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: build_sessions build_sessions_sandbox_id_sandboxes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_sessions
    ADD CONSTRAINT build_sessions_sandbox_id_sandboxes_id_fk FOREIGN KEY (sandbox_id) REFERENCES public.sandboxes(id) ON DELETE SET NULL;


--
-- Name: build_sessions build_sessions_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.build_sessions
    ADD CONSTRAINT build_sessions_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: meter_limits meter_limits_meter_key_meters_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_limits
    ADD CONSTRAINT meter_limits_meter_key_meters_key_fk FOREIGN KEY (meter_key) REFERENCES public.meters(key) ON DELETE RESTRICT;


--
-- Name: meter_limits meter_limits_plan_id_plans_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_limits
    ADD CONSTRAINT meter_limits_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: meter_usage meter_usage_meter_key_meters_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_usage
    ADD CONSTRAINT meter_usage_meter_key_meters_key_fk FOREIGN KEY (meter_key) REFERENCES public.meters(key) ON DELETE RESTRICT;


--
-- Name: meter_usage meter_usage_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meter_usage
    ADD CONSTRAINT meter_usage_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: plan_entitlements plan_entitlements_capability_key_capabilities_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_entitlements
    ADD CONSTRAINT plan_entitlements_capability_key_capabilities_key_fk FOREIGN KEY (capability_key) REFERENCES public.capabilities(key) ON DELETE RESTRICT;


--
-- Name: plan_entitlements plan_entitlements_plan_id_plans_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_entitlements
    ADD CONSTRAINT plan_entitlements_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: project_repositories project_repositories_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_repositories
    ADD CONSTRAINT project_repositories_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_owner_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_owner_id_users_uid_fk FOREIGN KEY (owner_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: rate_limits rate_limits_plan_id_plans_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: sandbox_providers sandbox_providers_concurrency_meter_key_meters_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_providers
    ADD CONSTRAINT sandbox_providers_concurrency_meter_key_meters_key_fk FOREIGN KEY (concurrency_meter_key) REFERENCES public.meters(key) ON DELETE RESTRICT;


--
-- Name: sandboxes sandboxes_project_id_projects_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandboxes
    ADD CONSTRAINT sandboxes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: sandboxes sandboxes_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandboxes
    ADD CONSTRAINT sandboxes_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: session_events session_events_session_id_build_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_events
    ADD CONSTRAINT session_events_session_id_build_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.build_sessions(id) ON DELETE CASCADE;


--
-- Name: session_messages session_messages_session_id_build_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_messages
    ADD CONSTRAINT session_messages_session_id_build_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.build_sessions(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_plans_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;


--
-- Name: subscriptions subscriptions_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: usage_ledger usage_ledger_meter_key_meters_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_ledger
    ADD CONSTRAINT usage_ledger_meter_key_meters_key_fk FOREIGN KEY (meter_key) REFERENCES public.meters(key) ON DELETE RESTRICT;


--
-- Name: usage_ledger usage_ledger_reservation_id_usage_reservations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_ledger
    ADD CONSTRAINT usage_ledger_reservation_id_usage_reservations_id_fk FOREIGN KEY (reservation_id) REFERENCES public.usage_reservations(id) ON DELETE SET NULL;


--
-- Name: usage_ledger usage_ledger_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_ledger
    ADD CONSTRAINT usage_ledger_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: usage_reservations usage_reservations_meter_key_meters_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_meter_key_meters_key_fk FOREIGN KEY (meter_key) REFERENCES public.meters(key) ON DELETE RESTRICT;


--
-- Name: usage_reservations usage_reservations_user_id_users_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_user_id_users_uid_fk FOREIGN KEY (user_id) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict aeu7ucEZ2E4CSOfbzgLBuYK4Dpge5ltvQtcuAiV42joJzAV5ytKz7tvenwsoltR

