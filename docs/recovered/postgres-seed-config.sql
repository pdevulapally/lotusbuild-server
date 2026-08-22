--
-- PostgreSQL database dump
--

\restrict KOMNwueGHFSDrDzaPmckayHU0G4W6bcMqdORkRuDLDaueVvKtr2u1ybQFeU6Smc

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
-- Data for Name: capabilities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.capabilities (key, value_kind, merge_strategy, description, created_at, updated_at, label) FROM stdin;
ai.run	boolean	MAX	May invoke the AI at all. MAX so a grant can enable but never revoke.	2026-07-27 20:49:24.080476+00	2026-07-27 20:49:24.080476+00	AI builds
ai.model.allowlist	stringList	INTERSECTION	Models this plan may use. INTERSECTION so a narrower source tightens rather than widens; empty means unrestricted.	2026-07-27 20:49:24.100103+00	2026-07-27 20:49:24.100103+00	Models
ai.effort	string	OVERRIDE	output_config.effort for this plan. The largest cost/quality lever, and therefore plan data rather than a constant.	2026-07-27 20:49:24.116507+00	2026-07-27 20:49:24.116507+00	AI effort
platform.mobile	boolean	MAX	May build mobile (Expo) projects, which run in a VPS sandbox.	2026-07-27 20:49:24.13135+00	2026-07-27 20:49:24.13135+00	Mobile apps
platform.web	boolean	MAX	May build web projects, which run in an E2B sandbox.	2026-07-27 20:49:24.147765+00	2026-07-27 20:49:24.147765+00	Web apps
projects.max	number	MAX	Maximum concurrent projects the user may own.	2026-07-27 20:49:24.163073+00	2026-07-27 20:49:24.163073+00	Projects
git.persistence	boolean	MAX	May commit generated code to a real repository.	2026-07-27 20:49:24.178827+00	2026-07-27 20:49:24.178827+00	Git repositories
preview.live	boolean	MAX	May run a generated app and serve a live preview URL.	2026-07-27 20:49:24.194207+00	2026-07-27 20:49:24.194207+00	Live preview
\.


--
-- Data for Name: entitlement_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entitlement_sources (key, precedence, description, created_at, updated_at) FROM stdin;
plan	0	The user's effective subscription plan.	2026-07-27 20:49:24.20915+00	2026-07-27 20:49:24.20915+00
\.


--
-- Data for Name: meter_limits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.meter_limits (plan_id, meter_key, included_allowance, hard_limit, overage_enabled, created_at, updated_at) FROM stdin;
897b1aa1-914d-49a7-b31f-6020c10c53e0	ai.tokens.output	30000	30000	f	2026-07-27 20:49:24.468623+00	2026-07-27 20:49:24.468623+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	sandbox.seconds	3600	3600	f	2026-07-27 20:49:24.487235+00	2026-07-27 20:49:24.487235+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	sandbox.concurrent.mobile	0	0	f	2026-07-27 20:49:24.502651+00	2026-07-27 20:49:24.502651+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	sandbox.concurrent.web	1	1	f	2026-07-27 20:49:24.519043+00	2026-07-27 20:49:24.519043+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	builds.started	10	10	f	2026-07-27 20:49:24.538376+00	2026-07-27 20:49:24.538376+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	storage.bytes	104857600	104857600	f	2026-07-27 20:49:24.553217+00	2026-07-27 20:49:24.553217+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	ai.tokens.input	1200000	2000000	t	2026-07-27 20:49:24.692801+00	2026-07-27 20:49:24.692801+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	ai.tokens.output	200000	400000	t	2026-07-27 20:49:24.707235+00	2026-07-27 20:49:24.707235+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	sandbox.seconds	36000	72000	t	2026-07-27 20:49:24.72299+00	2026-07-27 20:49:24.72299+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	sandbox.concurrent.mobile	1	1	f	2026-07-27 20:49:24.737013+00	2026-07-27 20:49:24.737013+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	sandbox.concurrent.web	3	3	f	2026-07-27 20:49:24.75226+00	2026-07-27 20:49:24.75226+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	builds.started	200	400	t	2026-07-27 20:49:24.76544+00	2026-07-27 20:49:24.76544+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	storage.bytes	5368709120	5368709120	f	2026-07-27 20:49:24.779857+00	2026-07-27 20:49:24.779857+00
546cde91-f08d-430a-b563-5bbad597d820	ai.tokens.input	3000000	6000000	t	2026-07-27 20:49:24.908851+00	2026-07-27 20:49:24.908851+00
546cde91-f08d-430a-b563-5bbad597d820	ai.tokens.output	500000	1000000	t	2026-07-27 20:49:24.921624+00	2026-07-27 20:49:24.921624+00
546cde91-f08d-430a-b563-5bbad597d820	sandbox.seconds	108000	216000	t	2026-07-27 20:49:24.935216+00	2026-07-27 20:49:24.935216+00
546cde91-f08d-430a-b563-5bbad597d820	sandbox.concurrent.mobile	2	2	f	2026-07-27 20:49:24.94998+00	2026-07-27 20:49:24.94998+00
546cde91-f08d-430a-b563-5bbad597d820	sandbox.concurrent.web	10	10	f	2026-07-27 20:49:24.965006+00	2026-07-27 20:49:24.965006+00
546cde91-f08d-430a-b563-5bbad597d820	builds.started	1000	2000	t	2026-07-27 20:49:24.979855+00	2026-07-27 20:49:24.979855+00
546cde91-f08d-430a-b563-5bbad597d820	storage.bytes	26843545600	26843545600	f	2026-07-27 20:49:24.994172+00	2026-07-27 20:49:24.994172+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	ai.tokens.input	300000	300000	f	2026-07-27 20:49:24.452978+00	2026-07-27 20:49:24.452978+00
\.


--
-- Data for Name: meters; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.meters (key, unit, kind, reset_period, description, created_at, updated_at, label) FROM stdin;
ai.tokens.input	tokens	COUNTER	MONTHLY	Input tokens billed to the AI provider. The dominant variable cost.	2026-07-27 20:49:24.225596+00	2026-07-27 20:49:24.225596+00	Input tokens
ai.tokens.output	tokens	COUNTER	MONTHLY	Output tokens billed to the AI provider. Five times the price of input.	2026-07-27 20:49:24.2435+00	2026-07-27 20:49:24.2435+00	Output tokens
sandbox.seconds	seconds	COUNTER	MONTHLY	Wall-clock sandbox time. E2B bills per second; the VPS is capacity-bound.	2026-07-27 20:49:24.25664+00	2026-07-27 20:49:24.25664+00	Sandbox time
sandbox.concurrent.mobile	count	GAUGE	NEVER	Mobile sandboxes running at once. Bounded by VPS RAM (~3-4 total), so this is a hardware ceiling rather than a commercial one.	2026-07-27 20:49:24.269571+00	2026-07-27 20:49:24.269571+00	Concurrent mobile sandboxes
sandbox.concurrent.web	count	GAUGE	NEVER	Web sandboxes running at once. Bounded by the E2B account's concurrency cap.	2026-07-27 20:49:24.282429+00	2026-07-27 20:49:24.282429+00	Concurrent web sandboxes
builds.started	count	COUNTER	MONTHLY	Build sessions started. The product-level limit users actually understand.	2026-07-27 20:49:24.295231+00	2026-07-27 20:49:24.295231+00	Builds
storage.bytes	bytes	GAUGE	NEVER	Bytes held across repositories and artefacts.	2026-07-27 20:49:24.30799+00	2026-07-27 20:49:24.30799+00	Storage
\.


--
-- Data for Name: plan_entitlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plan_entitlements (plan_id, capability_key, value, created_at, updated_at) FROM stdin;
546cde91-f08d-430a-b563-5bbad597d820	ai.effort	{"kind": "string", "value": "xhigh"}	2026-07-27 20:49:24.830996+00	2026-07-27 20:49:24.830996+00
546cde91-f08d-430a-b563-5bbad597d820	platform.web	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.843747+00	2026-07-27 20:49:24.843747+00
546cde91-f08d-430a-b563-5bbad597d820	platform.mobile	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.85744+00	2026-07-27 20:49:24.85744+00
546cde91-f08d-430a-b563-5bbad597d820	projects.max	{"kind": "number", "value": 100}	2026-07-27 20:49:24.87113+00	2026-07-27 20:49:24.87113+00
546cde91-f08d-430a-b563-5bbad597d820	git.persistence	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.884098+00	2026-07-27 20:49:24.884098+00
546cde91-f08d-430a-b563-5bbad597d820	preview.live	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.896456+00	2026-07-27 20:49:24.896456+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	ai.run	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.337806+00	2026-07-27 20:49:24.337806+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	ai.model.allowlist	{"kind": "stringList", "value": ["claude-opus-5"]}	2026-07-27 20:49:24.354744+00	2026-07-27 20:49:24.354744+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	ai.effort	{"kind": "string", "value": "low"}	2026-07-27 20:49:24.368305+00	2026-07-27 20:49:24.368305+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	platform.web	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.382379+00	2026-07-27 20:49:24.382379+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	platform.mobile	{"kind": "boolean", "value": false}	2026-07-27 20:49:24.396972+00	2026-07-27 20:49:24.396972+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	projects.max	{"kind": "number", "value": 3}	2026-07-27 20:49:24.411068+00	2026-07-27 20:49:24.411068+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	git.persistence	{"kind": "boolean", "value": false}	2026-07-27 20:49:24.42443+00	2026-07-27 20:49:24.42443+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	preview.live	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.439516+00	2026-07-27 20:49:24.439516+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	ai.run	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.582871+00	2026-07-27 20:49:24.582871+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	ai.model.allowlist	{"kind": "stringList", "value": ["claude-opus-5"]}	2026-07-27 20:49:24.597617+00	2026-07-27 20:49:24.597617+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	ai.effort	{"kind": "string", "value": "high"}	2026-07-27 20:49:24.612945+00	2026-07-27 20:49:24.612945+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	platform.web	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.626322+00	2026-07-27 20:49:24.626322+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	platform.mobile	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.639693+00	2026-07-27 20:49:24.639693+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	projects.max	{"kind": "number", "value": 25}	2026-07-27 20:49:24.652747+00	2026-07-27 20:49:24.652747+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	git.persistence	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.666969+00	2026-07-27 20:49:24.666969+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	preview.live	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.679507+00	2026-07-27 20:49:24.679507+00
546cde91-f08d-430a-b563-5bbad597d820	ai.run	{"kind": "boolean", "value": true}	2026-07-27 20:49:24.806081+00	2026-07-27 20:49:24.806081+00
546cde91-f08d-430a-b563-5bbad597d820	ai.model.allowlist	{"kind": "stringList", "value": ["claude-opus-5"]}	2026-07-27 20:49:24.81853+00	2026-07-27 20:49:24.81853+00
\.


--
-- Data for Name: plans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.plans (id, key, name, status, rank, created_at, updated_at) FROM stdin;
897b1aa1-914d-49a7-b31f-6020c10c53e0	free	Free	ACTIVE	0	2026-07-27 20:49:24.322527+00	2026-07-27 20:49:24.322527+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	pro	Pro	ACTIVE	1	2026-07-27 20:49:24.568036+00	2026-07-27 20:49:24.568036+00
546cde91-f08d-430a-b563-5bbad597d820	business	Business	ACTIVE	2	2026-07-27 20:49:24.793045+00	2026-07-27 20:49:24.793045+00
\.


--
-- Data for Name: rate_limits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rate_limits (plan_id, route_class, max_requests, window_seconds, created_at, updated_at) FROM stdin;
897b1aa1-914d-49a7-b31f-6020c10c53e0	read	120	60	2026-07-29 15:09:07.603234+00	2026-07-29 15:09:07.603234+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	write	20	60	2026-07-29 15:09:07.606135+00	2026-07-29 15:09:07.606135+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	build	3	60	2026-07-29 15:09:07.607349+00	2026-07-29 15:09:07.607349+00
897b1aa1-914d-49a7-b31f-6020c10c53e0	stream	20	60	2026-07-29 15:09:07.608569+00	2026-07-29 15:09:07.608569+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	read	300	60	2026-07-29 15:09:07.62931+00	2026-07-29 15:09:07.62931+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	write	60	60	2026-07-29 15:09:07.63037+00	2026-07-29 15:09:07.63037+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	build	10	60	2026-07-29 15:09:07.631681+00	2026-07-29 15:09:07.631681+00
0a427c3d-ced8-40c8-9265-3f593a3411cb	stream	60	60	2026-07-29 15:09:07.632755+00	2026-07-29 15:09:07.632755+00
546cde91-f08d-430a-b563-5bbad597d820	read	600	60	2026-07-29 15:09:07.65033+00	2026-07-29 15:09:07.65033+00
546cde91-f08d-430a-b563-5bbad597d820	write	120	60	2026-07-29 15:09:07.651235+00	2026-07-29 15:09:07.651235+00
546cde91-f08d-430a-b563-5bbad597d820	build	30	60	2026-07-29 15:09:07.652204+00	2026-07-29 15:09:07.652204+00
546cde91-f08d-430a-b563-5bbad597d820	stream	120	60	2026-07-29 15:09:07.653121+00	2026-07-29 15:09:07.653121+00
\.


--
-- Data for Name: sandbox_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sandbox_providers (platform, provider, template, timeout_seconds, memory_mb, cpus, concurrency_meter_key, created_at, updated_at, workdir, idle_grace_seconds, agent_instructions) FROM stdin;
mobile	vps	lotusbuild-expo:2	1800	1536	1	sandbox.concurrent.mobile	2026-07-27 21:49:58.515406+00	2026-07-27 21:49:58.515406+00	/workspace	300	This is an Expo (React Native) project. A blank Expo app with web support is already installed at the project root — edit it rather than scaffolding a new one, and do not run create-expo-app.\n\nWrite screens in App.js (or App.tsx) and files it imports. Use React Native components — View, Text, Pressable, FlatList, StyleSheet — never HTML elements like div or span, which do not exist here.\n\nTo show the user their app, run start_preview with:\n  command: npx expo start --web --port 8081 --host lan\n  port: 8081\n\nThat serves the app through react-native-web, which is what the user sees in the preview. The same server also hosts the Expo Go manifest, so one command covers both the browser preview and the QR code for a real phone — do not start a second server for it.\n\nOnly add a dependency if the app genuinely needs it: installing packages on this sandbox is slow, and every one is time the user spends watching a spinner.
web	e2b	base	1800	2048	2	sandbox.concurrent.web	2026-07-27 21:49:58.534694+00	2026-07-27 21:49:58.534694+00	/home/user/project	300	This is a web project. Scaffold with Vite unless the user asks for something else, and prefer React with TypeScript.\n\nTo show the user their app, run start_preview with the dev server command and its port, for example:\n  command: npm run dev -- --host 0.0.0.0 --port 5173\n  port: 5173\n\nThe --host flag is required. A dev server bound only to localhost cannot be reached from outside the sandbox, so the preview will time out even though the server is running.
\.


--
-- PostgreSQL database dump complete
--

\unrestrict KOMNwueGHFSDrDzaPmckayHU0G4W6bcMqdORkRuDLDaueVvKtr2u1ybQFeU6Smc

