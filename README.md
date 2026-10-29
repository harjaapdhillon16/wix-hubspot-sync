# Wix ↔ HubSpot Integration (self-hosted Wix app)

A Wix app that lets a site owner:

1. **Connect HubSpot** with OAuth 2.0 from the Wix dashboard, and disconnect it again.
2. **Sync contacts both ways** between Wix and HubSpot (create and update, both directions), with user-configurable field mapping, a conflict rule, and loop prevention.
3. **Send Wix Forms leads to HubSpot** within seconds, with UTM, page URL, referrer and timestamp attribution stored as HubSpot contact properties.

The API choices for each feature are in **[docs/API_PLAN.md](docs/API_PLAN.md)** (Deliverable A).

```
                 Wix site / dashboard                                 HubSpot
 ┌──────────────────────────────────────────┐            ┌──────────────────────────────┐
 │ Dashboard page (iframe) ─ instance token │            │ OAuth consent                │
 │ Embedded script (UTM capture → beacon)   │            │ CRM v3 Contacts / Properties │
 │ Contacts v4 / Forms v4 webhooks (JWT)    │            │ Webhooks (signature v3)      │
 └──────────────┬───────────────────────────┘            └──────────────┬───────────────┘
                │                                                      │
        ┌───────▼──────────────────────────────────────────────────────▼───────┐
        │  This server (Node/Express)                                          │
        │  /api/*        dashboard API (Wix instance auth)                     │
        │  /oauth/*      HubSpot OAuth callback                                │
        │  /webhooks/*   Wix + HubSpot webhooks → durable job queue            │
        │  SyncEngine    field-level 3-way merge, conflict rule, idempotency   │
        │  FormCapture   submission → HubSpot upsert + attribution             │
        │  SecretStore   Google Secret Manager (tokens) │ SQLite (state, no PII)│
        └──────────────────────────────────────────────────────────────────────┘
```

## Try it locally in 1 minute (no Wix or HubSpot account needed)

```bash
npm install
```

```bash
npm run dev:mock
```

This boots the **real app** (same routes, OAuth flow, signature checks, queue and engine) against an in-memory **HubSpot emulator** and a **fake Wix site**. It prints three URLs:

| URL | What it is |
|---|---|
| `http://localhost:3000/dashboard/?instance=…` | The app dashboard, exactly as Wix would iframe it |
| `http://localhost:4010/_ui` | Mock HubSpot CRM: edit contacts "in HubSpot" |
| `http://localhost:4020` | Mock Wix site: a landing page with UTM links, a contact form running the real attribution script, and a Wix Contacts admin |

Suggested walkthrough:
1. In the dashboard, click **Connect HubSpot** → **Connect app**.
2. Open `http://localhost:4020/?utm_source=google&utm_medium=cpc&utm_campaign=spring_sale`, go to **Contact form**, and submit it.
3. In mock HubSpot, the contact appears with `wix_utm_*`, `wix_first_utm_*`, `wix_page_url`, `wix_landing_page` and `lifecyclestage=lead`.
4. Edit the contact's company in mock HubSpot. It shows up in **Wix Contacts**. Edit the last name in Wix and it shows up in HubSpot.
5. The dashboard's **Sync activity** shows each `updated` and the `echo ignored` entry for the app's own writes. No ping-pong.
6. Add a mapping row (for example *Membership tier (custom)* ⇄ *Membership tier*), save it, and change the value in HubSpot.

## Tests

```bash
npm test
```

There are 31 tests: unit tests plus end-to-end tests over HTTP against the emulators. They cover:
- Wix create → HubSpot, HubSpot create → Wix, updates in both directions with **exact write counts** (no ping-pong). Every sync test runs twice, the second time with HubSpot origin tags switched off, to prove the hash/idempotency layer stops loops on its own.
- Matching by email instead of duplicating, filling gaps on first sync, and **last-updated-wins** when the same field is edited on both sides.
- Mapping rules: direction, transforms, defaults, custom fields, and duplicate-target validation (422).
- Form submission → HubSpot with UTM attribution in under 5 s (it measures under 1 s), first-touch preservation, and the hidden-field fallback.
- Security: 401 without a valid Wix instance, forged webhooks rejected, tokens never in API responses and encrypted at rest, single-use OAuth state, token refresh, and disconnect revoking and deleting tokens.

## Setting it up for real

### 1. HubSpot developer app
1. Create a public app in a HubSpot developer account.
2. **Auth**: set the redirect URL to `https://<APP_BASE_URL>/oauth/hubspot/callback`, with scopes `oauth crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write`.
3. **Webhooks**: set the target URL to `https://<APP_BASE_URL>/webhooks/hubspot`. Subscribe to `contact.creation`, `contact.deletion`, and `contact.propertyChange` for each synced property (`email`, `firstname`, `lastname`, `phone`, `company`, `jobtitle`, plus any you map). The poller covers properties without a subscription.
4. Copy the client id, client secret and app id into the env.

### 2. Wix app (Wix Dev Center, self-hosted)
1. Create an app and copy the **App ID** and **App Secret**.
2. **Extensions → Dashboard Page**: iframe URL `https://<APP_BASE_URL>/dashboard/`.
3. **Webhooks**: callback `https://<APP_BASE_URL>/webhooks/wix` for *Contact Created*, *Contact Updated*, *Contact Deleted*, *Form Submission Created* and *App Removed*. Copy the **public key** into `WIX_PUBLIC_KEY`.
4. **Extensions → Embedded Script** (type: *Functional*, placement: *Body end*) with this template:
   `<script async src="{{scriptUrl}}" data-site-key="{{siteKey}}" data-endpoint="{{endpoint}}"></script>`
5. **Permissions**: Manage Contacts (read/write), Read Forms submissions, Manage Embedded Scripts.

### 3. Run it
```bash
cp .env.example .env
```
Fill in `.env`, then:
```bash
npm run build
```
```bash
npm start
```
Or deploy the `Dockerfile` (for example to Cloud Run with a service account that has Secret Manager access, and `SECRET_STORE=gcp`). SQLite needs a persistent disk with a single instance. For horizontal scale, swap `db.ts`/`store.ts` for Postgres; the rest of the code only talks to `Store`.

## Project layout

```
src/server/
  app.ts, index.ts, context.ts     composition root, HTTP app, wiring
  config.ts, logger.ts, crypto.ts  env validation, PII/token-safe logging, AES-GCM/HMAC
  db.ts, store.ts                  SQLite schema + repository (no tokens, no raw PII)
  secrets/                         SecretStore: Google Secret Manager + local encrypted
  wix/                             instance-token auth, SDK gateway, webhook parser, field catalog
  hubspot/                         OAuth + refresh/revoke, CRM client, webhook signature v3
  sync/                            engine (3-way merge, conflicts), mapping rules, durable queue
  forms/                           submission parsing, attribution properties, HubSpot upsert
  routes/                          /api, /oauth, /webhooks, /public
  jobs.ts                          reconcile / form / full sync / poll / uninstall handlers
src/dashboard/                     React + Wix Design System dashboard page
src/shared/types.ts                types shared by server and dashboard
public/attribution.js              embedded site script (UTM capture + beacon)
dev/                               HubSpot emulator, fake Wix, stack bootstrap, mock demo
test/                              unit + end-to-end tests
```

## Known limitations / next steps
- HubSpot `contact.propertyChange` needs one subscription per property. Properties mapped later are picked up by the poller (every 5 minutes by default) until a subscription is added.
- Conflict timestamps are record-level (Wix `_updatedDate` vs HubSpot `lastmodifieddate`). Per-property HubSpot history (`propertiesWithHistory`) could make this per-field.
- Deletes are not propagated on purpose. Deleting on one side unlinks the pair; it never deletes data on the other side.
- The attribution script detects the email field heuristically. Owners can also add hidden `utm_*` fields to a form, which are used as a fallback.
