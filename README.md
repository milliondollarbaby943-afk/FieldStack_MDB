# FieldStack — AI Foreman for Cabinet & Countertop Subs

FieldStack is a construction schedule intelligence platform built for cabinet and countertop subcontractors. Upload a GC's PDF schedule, and FieldStack parses it with AI, builds a live workflow, tracks orders, and keeps GC and Sub teams in sync.

**Live:** https://fieldstack-testing-9d632.web.app

---

## What it does

**Schedule Intelligence**
- Drop a PDF schedule → Claude vision parses every task, date, building, and floor
- Auto-creates a new project from the upload (no manual setup needed)
- Detects schedule changes between uploads and notifies the team
- Generates a 6-step workflow chain per building/floor (Shop Drawings → Submissions → Order Materials → Confirm Delivery → Install → Punch List)
- Computes order-by dates from lead times so nothing gets ordered late

**Two-User Model: GC + Sub**
- GC uploads the master schedule and owns the source of truth
- GC invites sub companies via a signed email link → sub accepts at `/invite/accept`
- GC assigns tasks to connected subs per row, or in bulk by building/floor/category
- Sub sees only their assigned tasks in a real-time dashboard
- Sub updates step status and notes; GC sees live progress
- Sub can request date changes; GC approves or rejects with inline diff

**AI Foreman**
- Chat interface for project Q&A, schedule analysis, and draft communications
- Daily briefing with upcoming orders and schedule alerts
- GC draft generator for sub-facing schedule update emails

**Integrations (in progress)**
- Procore & Buildertrend nightly sync
- Gmail integration for inbound schedule PDFs
- SMS briefings via Twilio

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite, shadcn/ui, Tailwind CSS |
| Backend | Firebase Cloud Functions (Node 20, Gen1) |
| Database | Firestore (multi-tenant: `companies/{id}/projects/{id}/...`) |
| Auth | Firebase Auth (email/password) |
| AI | Anthropic Claude (Haiku for parsing, Sonnet for chat) |
| Email | Resend |
| Billing | Stripe |
| Hosting | Firebase Hosting |

---

## Data model

```
companies/{companyId}/
  ├── projects/{projectId}/
  │   ├── tasks/{taskId}           — parsed from schedule PDF
  │   ├── orderItems/{itemId}      — derived from tasks, tracks PO status
  │   ├── taskSteps/{stepId}       — 6-step workflow chain per building/floor
  │   ├── scheduleChanges/{id}     — diff between upload versions
  │   ├── pendingChanges/{id}      — sub date change requests + GC approval
  │   ├── feedEntries/{id}         — project activity feed
  │   └── scheduleUploads/{id}     — upload history
  ├── projectConnections/{id}      — GC ↔ Sub company links (invite flow)
  ├── teamMembers/{id}
  └── leadTimeSettings/{id}
companyMembers/{companyId}_{uid}   — flat collection for uid lookups
```

---

## Project structure

```
.
├── frontend/               React SPA
│   └── src/
│       ├── pages/          Dashboard, ProjectDetail, SubDashboardPage,
│       │                   AcceptInvitePage, MyTasksPage, TeamPage, ...
│       ├── components/
│       │   └── fieldstack/tabs/   TimelineTab, WorkflowTab, OrdersTab,
│       │                          UploadTab, PendingChangesTab, ...
│       ├── hooks/          useProjectData, useSubTasks, useProjectConnections
│       └── lib/            fieldstackApi.ts, firebase.ts
│
├── functions/src/fieldstack/
│   ├── schedules.ts        PDF upload + Claude vision parse pipeline
│   ├── fromSchedule.ts     Create project from PDF (no pre-existing project)
│   ├── inviteSub.ts        GC invite flow + HMAC-signed tokens
│   ├── pendingChanges.ts   Sub date change requests + GC approval
│   ├── steps.ts            Step status updates + cascade logic
│   ├── chat.ts             AI Foreman chat + briefing
│   ├── orders.ts           Order item management
│   ├── projects.ts         Project CRUD
│   ├── team.ts             Team member management
│   └── types.ts            COLLECTIONS map + shared types
│
├── firestore.rules         Multi-tenant security rules
├── firestore.indexes.json  Composite indexes
└── firebase.json           Hosting rewrites for all API endpoints
```

---

## Local development

```bash
# Install
cd frontend && npm install
cd functions && npm install

# Run emulators
firebase emulators:start

# Frontend dev server (in a separate terminal)
cd frontend && npm run dev
```

Set `VITE_USE_EMULATORS=true` in `frontend/.env` to point the app at local emulators.

---

## Deploy

```bash
# Build
cd functions && npm run build
cd frontend && npm run build

# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only hosting + rules
firebase deploy --only hosting,firestore:rules
```

**Required Firebase Secrets** (set via `firebase functions:secrets:set <NAME>`):
- `ANTHROPIC_API_KEY` — schedule parsing and AI features

**Required `functions/.env` values:**
- `APP_URL` — your hosting URL (used in invite email links)
- `CORS_ORIGIN` — comma-separated allowed origins (same as APP_URL)
- `RESEND_API_KEY` — invite and notification emails
- `EMAIL_FROM` — sender address e.g. `FieldStack <noreply@yourdomain.com>`
- `MAGIC_LINK_SECRET` — JWT signing secret for magic link auth
- `INVITE_SECRET` — HMAC signing secret for sub invite tokens

---

## Feature backlog

| ID | Feature |
|---|---|
| fi-kcp | Procore & Buildertrend auto-sync (nightly API polling) |
| fi-0r4 | Secure GC upload link (weekly email with one-time upload URL) |
| fi-09y | Document repository (RFIs, submittals, contracts, drawings) |
| fi-j8b | Mobile push notifications |
| fi-qea | Project finance tracking (sub cost, labor, margin per job) |
