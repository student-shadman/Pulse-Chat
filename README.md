# Pulse-Chat
Connect. Communicate. Instantly.
# PulseChat — Real-Time Communication Platform

A real-time chat platform built with Node.js, Express, Socket.io, and vanilla HTML/CSS/JS.
No database, no build step, no framework — just a fast, in-memory server and a polished client.

This is the **Version 2 ("Premium Chat")** upgrade of the original single-room demo: multi-room
navigation, rich messages, presence, and a distinctive glassmorphism UI with five themes.

## Features

**Core**
- Real-time messaging over Socket.io, with reconnect + delivery/seen receipts
- Multiple rooms with a searchable sidebar, live online counts, and room creation
- Typing indicators (debounced), presence, and join/leave system messages
- Rate limiting and server-side input sanitization (text and image payloads)

**Messages**
- Text, image attachments, timestamps, and date dividers
- Reactions (emoji, toggleable, multi-user)
- Replies with a quoted preview and jump-to-original
- Edit and delete (delete removes content for everyone, matching the sender check)
- Pin / unpin, with a pinned strip and a dedicated Pinned panel
- Save / bookmark messages (stored locally per browser)
- @mentions (including @everyone) with highlighting and a notification bell
- In-room message search with highlighting (Ctrl/Cmd+K)
- Slash commands: `/help`, `/clear`

**UI/UX**
- Five themes: Aurora, Midnight, Sunset, Forest, Minimal (saved to the browser)
- Responsive layout: collapsible sidebar and right panel on mobile
- Smart auto-scroll with a "jump to new messages" affordance
- Emoji picker, mention autocomplete, auto-growing composer
- Accessible focus states and `prefers-reduced-motion` support

## What's intentionally out of scope for this version

The original feature brainstorm (document you shared) covers an enterprise-scale product:
authentication, a database, Redis-backed horizontal scaling, direct messages, friends/communities,
voice/video calling, and end-to-end encryption. Those require real architectural decisions
(a persistence layer, an auth provider, infrastructure for scaling) rather than just more
frontend code, so they're left as a deliberate "Version 3" next step rather than bolted on
in a way that would be fragile or insecure. Everything shipped here still works without a
database, matching the original project's constraint.

## Folder Structure

```text
.
|-- public
|   |-- css
|   |   `-- styles.css
|   |-- js
|   |   `-- app.js
|   `-- index.html
|-- .gitignore
|-- package.json
|-- README.md
|-- render.yaml
`-- server.js
```

## Run Locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the server:

   ```bash
   npm start
   ```

3. Open the app:

   ```text
   http://localhost:3000
   ```

Open a second browser tab (or an incognito window) with a different username to see real-time
sync, presence, typing indicators, and reactions in action.

## Deploy on Render

### Option 1: Web Service

1. Push this project to GitHub, GitLab, or Bitbucket.
2. In Render, create a new `Web Service`.
3. Connect your repository.
4. Use these settings:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Deploy.

The app reads `process.env.PORT`, so it works with Render's assigned port automatically.

### Option 2: Blueprint

1. Push the project (with `render.yaml`) to your repository.
2. In Render, create a new `Blueprint`.
3. Select the repository — Render applies the config from `render.yaml`.

## Notes & limitations

- No database or authentication service — messages, rooms, reactions, and pins reset when the
  server restarts. Saved messages persist per-browser via `localStorage`.
- Edit/delete/pin authorization is checked against the sender's live socket connection, so a
  user who reconnects (new socket id) can't edit an older message from a prior connection —
  a real auth layer would be needed to fix this properly, which is part of the "Version 3" scope.
- Image sharing uses base64 data URLs held in memory (capped at ~6MB decoded) — fine for a
  demo/portfolio project, but a production version should move to object storage (S3, R2, etc.).
- The last 500 messages per room are kept in memory for scrollback; older messages are trimmed.
