# Desktop: what the frontend needs to build

Backend is deployed (relay, runner side, ticket endpoint, events). The computer tool (the agent operating the screen) is a separate change, PR #8, called out where it matters. **Nothing shows a desktop today**: the live registry has no desktop row until the operator applies it, so no session emits `desktop.*` events yet. Build against the contract below; treat "no desktop" as the normal state and never assume one exists.

The user watches a live desktop of the sandbox the agent is working in. **View-only**: it is enforced at the VNC server inside the sandbox, so a client cannot type or click on it however it is written. Do not build input affordances. "Take over" is not supported.

## 1. Know when a desktop exists: session events

Two events on the existing SSE stream (`GET /sessions/:id/events`, same framing, `Last-Event-ID` resume):

| event | data | meaning |
| --- | --- | --- |
| `desktop.ready` | `{ width, height }` | A desktop is up and can be watched. Size is the remote screen in pixels. |
| `desktop.ended` | `{ reason }` | `reason` is `session-ended` (the run finished or failed and its machine was released), `sandbox-stopped` (the runner died and recovery ended it) or `error` (it failed to start). |

- **Fold events in order; the last one wins.** They are persisted and replayed on resume, so a client that connects late sees `desktop.ready` and then, if it happened, `desktop.ended`. Do not treat a replayed `ready` as "the desktop is up now".
- `error` can arrive with **no preceding `ready`**: the desktop failed to start and the build carries on without it. Show "no desktop for this session", not an error banner. The build is fine.
- Never key the feature off the user's plan. Which plans and builds get a desktop is backend configuration and will change. Events are the only signal.
- `desktop.ended` ends **that run's** desktop, not the conversation. Every run gets its own sandbox, so a follow-up prompt starts a new run and, if it has a desktop, a new `desktop.ready`. `session-ended` means the run's machine was released, not that the session is over. Do not offer a reconnect to an ended desktop; wait for the next `ready`.

## 2. Open the stream: ticket, then WebSocket

The browser cannot send an `Authorization` header on a WebSocket, so there is a short-lived ticket.

```
POST /sessions/:sessionId/desktop-ticket
Authorization: Bearer <Firebase ID token>          (no body)
-> 200 { "ticket": "...", "expiresInSeconds": 30, "path": "/sessions/:sessionId/desktop" }
```

Then open `wss://<api host><path>?ticket=<ticket>` with subprotocol **`binary`** (noVNC's default).

- The ticket is **single use and lasts 30 seconds**. Fetch a **fresh one for every connect and every reconnect**. Never cache, retry with, store or log one; keep it out of analytics and error reports. It rides in the URL, so it must not survive in browser history, `Referer` or a copied URL.
- Ticket errors use the normal envelope `{ error: { code, message }, requestId }`:
  - `404` the session is not yours or does not exist
  - `409 session/no-desktop`: no desktop is running. Do not retry; wait for `desktop.ready`.
  - `429 desktop/capacity-reached`: too many viewers. Tell the user to close another view.
  - `429` rate limited (stream class): back off.
- Only origins in the API's CORS list may open the socket (checked separately from CORS, because WebSockets are not covered by it). Today that is the production domain and `http://localhost:3000`. **Preview deployments on other hostnames get `4403`.**
- Add the API's `wss://` origin to `connect-src` if you set a CSP.

## 3. Render with noVNC

Use `@novnc/novnc`'s `RFB` class against the URL above. There is no VNC password (security type "None"): do not prompt for credentials. Set `viewOnly = true` as well, as the honest UI state, and `scaleViewport = true` so the remote screen fits its box. Map noVNC's `connect` to "live" and `disconnect` to the close handling below.

**Not yet verified:** the relay has been checked with a plain WebSocket client against a real desktop (handshake banner, view-only held, clean close on desktop end), **not with the noVNC browser client**. Expect to be the first to try that; tell backend what you see.

## 4. Close codes: the relay never fails the upgrade

A failed upgrade shows a browser only a generic error, so every refusal is an accepted socket closed immediately with a code (the close reason string is the same token). Read `event.code`.

| code | reason | what to do |
| --- | --- | --- |
| 1000 | `desktop-ended` | Desktop is gone. Stop, no retry. |
| 1001 | `server-shutdown` | API restarted. Fetch a new ticket and reconnect with backoff. |
| 4400 | `protocol-abuse` | The client sent too much or something it should not. A bug on your side. Do not retry in a loop. |
| 4401 | `ticket-invalid` | Expired, used or unknown. Fetch a new ticket and retry **once**. |
| 4403 | `origin-not-allowed` | Wrong origin (see section 2). Do not retry. |
| 4404 | `session-not-found` | Do not retry. |
| 4409 | `no-desktop` | No desktop now. Wait for `desktop.ready`. |
| 4410 | `max-lifetime` | A socket has a hard lifetime. **Expected.** Fetch a new ticket and reconnect quietly, ideally without a flicker of UI. |
| 4413 | `slow-consumer` | The tab could not keep up. Reconnect with backoff; if it repeats, say the connection is too slow. |
| 4429 | `capacity-reached` | Too many viewers. Tell the user, do not retry automatically. |
| 4500 | `relay-error` | Retry with capped backoff, then give up visibly. |

An anonymous drop with no code (code 1006) is a network failure: treat it like `1001`.

## 5. Agent actions in the event stream (after PR #8 deploys)

When the agent operates the screen, the existing `agent.tool_call` / `agent.tool_result` events carry it:

- `agent.tool_call` `{ name, input }` with `name` one of `screenshot`, `zoom`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll`, `type`, `key`, `wait`. Coordinates in `input` are **pixels on the remote screen**, the size from `desktop.ready`, origin top-left.
- `agent.tool_result` `{ name, isError, text }`. `text` is a short line ("left_click at [143, 312]", "Screenshot 1280x800"). **Screenshots are never sent to the browser.** The user already has the live view.

Useful, optional: a step label ("Clicking Press me at 143, 312"), and a marker on the canvas at the action's coordinates (scale by displayed size / `desktop.ready` size). Render an unknown `name` as a generic step rather than failing; the list can grow.
`type` carries the text the agent typed. It is the agent's own text, not the user's secret, but treat it as untrusted content when rendering (no HTML).

## 6. Behaviour worth designing for

- **A desktop shows up mid-session** (after the sandbox starts). Reserve space or a placeholder; do not assume it is there when the session starts.
- **It disappears** when the sandbox does, and the last frame is gone. Show a clear "the desktop has ended" state, not a frozen canvas.
- **Several tabs**: per-user and per-session caps exist; the second view can be refused with 429 or `4429`.
- **Mobile / slow links**: `4413` is the relay protecting itself from a client that cannot keep up. Consider a visible "paused, connection too slow" state.

## 7. Testing

There is no live desktop to point at until the operator applies the registry change. Until then, develop against a mocked SSE stream and a mocked WebSocket that closes with the codes above. When it is applied, ask backend for a session to test against; the ticket and socket are real and private, so it needs a real signed-in test account.
