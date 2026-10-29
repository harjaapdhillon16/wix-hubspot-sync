# Deliverable A: API plan

Which APIs this integration uses for each feature, and why.

## Platform choice: a self-hosted Wix app

The assignment allows either Wix CLI or a self-hosted app. I chose **self-hosted** (Node + Express + the `@wix/sdk` with `AppStrategy`) because:

- HubSpot webhooks go to **one URL per HubSpot app**, which serves every portal and every Wix site. That calls for one backend that routes `portalId → Wix instance`, not per-site backend code.
- OAuth tokens have to live in a real secret store (Google Secret Manager) and be refreshed in the background, outside any one dashboard session.
- Sync needs a durable queue with retries and backoff, plus a polling fallback. Both are long-running server concerns.

The Wix-facing pieces are still standard Wix app extensions: a **Dashboard Page** (iframe to `/dashboard`), **Webhooks**, and an **Embedded Script**.

---

## Feature #1: bi-directional contact sync

| Purpose | API | Why |
|---|---|---|
| Wix → app: contact created / updated / deleted | **Wix Contacts v4 webhooks**: `wix.contacts.v4.contact_created`, `contact_updated`, `contact_deleted` (handled with `@wix/crm` `contacts.onContactCreated` / `onContactUpdated` / `onContactDeleted` + `client.webhooks.process()`) | Push-based and near real time. The JWT is signed with the app's key pair and verified with the app public key. `metadata.identity` tells us who made the change (origin tag). |
| Read / write Wix contacts | **Wix Contacts v4 REST via SDK**: `getContact`, `queryContacts` (filter `primaryInfo.email`), `createContact` (`allowDuplicates:false`), `updateContact(id, info, revision)` | `revision` gives optimistic concurrency, so a stale write fails and is retried after a fresh read. |
| Custom contact fields for the mapping UI | **Wix Extended Fields**: `extendedFields.listExtendedFields()` | Lists the site's `custom.*` fields so they can be mapped. |
| Read / write HubSpot contacts | **HubSpot CRM v3 Contacts API**: `GET /crm/v3/objects/contacts/{id}`, `POST /crm/v3/objects/contacts`, `PATCH /crm/v3/objects/contacts/{id}`, `POST /crm/v3/objects/contacts/search` (email EQ, `lastmodifieddate` GTE), `GET /crm/v3/objects/contacts` (paging) | Standard object API. Search by email matches existing contacts instead of creating duplicates. A 409 "Existing ID" on create is handled as an update. |
| HubSpot property list for the mapping UI | **HubSpot CRM v3 Properties API**: `GET /crm/v3/properties/contacts` | Populates the HubSpot dropdown and blocks read-only or calculated properties as write targets. |
| HubSpot → app: changes | **HubSpot Webhooks API** (app subscriptions): `contact.creation`, `contact.propertyChange` (one subscription per synced property), `contact.deletion`, `contact.privacyDeletion` | Near real time. Requests are verified with **signature v3** (HMAC-SHA256 with the client secret, 5-minute timestamp window). `changeSource` + `sourceId` mark writes our own app made (origin tag). |
| Safety net for HubSpot → Wix | **Polling** with the Contacts search API (`lastmodifieddate >= cursor - 60s`), every `POLL_INTERVAL_SECONDS` | Covers properties without a `propertyChange` subscription (for example custom properties added to the mapping later) and missed or failed deliveries. Polling is idempotent because the engine diffs before writing. |

### Conflict and loop-prevention design (four layers)

1. **External ID mapping.** `contact_links(instance_id, wix_contact_id ↔ hubspot_contact_id)`, plus per-field HMAC hashes of the values last known to be in sync, a `last_sync_id` (correlation id) and `last_sync_source`.
2. **Origin tags.** Wix webhooks whose `identity` is `{identityType: APP, appId: <our app>}` are dropped. So are HubSpot events with `changeSource ∈ {INTEGRATION, API}` and `sourceId == <our HubSpot app id>`. Each one is logged as `echo_ignored`.
3. **Event dedupe.** Every delivery id (`wix:<event id>`, `hs:<eventId>`) is recorded in `processed_events`. HubSpot's one-event-per-property bursts are collapsed by a debounced job `dedupeKey` per contact.
4. **Idempotency with a three-way, field-level merge.** The engine re-reads both records and compares each mapped field with its stored base hash:
   - only one side changed: copy that side to the other (if the row's direction allows it)
   - both changed: apply the conflict rule
   - neither changed: do nothing

   Only values that actually differ are written. After every write the new hashes are stored, so the echo of our own write finds "nothing changed". This layer alone stops ping-pong; the test suite runs every sync scenario with origin tags switched off to prove it.

**Conflict rule (configurable per site):** `last_updated_wins` (default; compares Wix `_updatedDate` with HubSpot `lastmodifieddate`), `hubspot_wins`, or `wix_wins`. It only applies when the *same field* changed on both sides since the last sync. Different fields changed on each side merge cleanly. On the first sync of a pair, empty values never overwrite filled ones (gap filling).

---

## Feature #2: form and lead capture (approach 2: Wix Forms as the UI, pushed to HubSpot)

| Purpose | API | Why |
|---|---|---|
| Submission trigger | **Wix Forms v4 webhook** `wix.forms.v4.submission_created` (`@wix/forms` `submissions.onSubmissionCreated`) | Fires for every Wix Form on the site. |
| Read the submission | **Wix Forms Submissions API** `submissions.getSubmission(id)` | The job stores only the submission id (no PII in the queue) and reads the values when it runs. |
| UTM / page / referrer capture | **Wix App Embedded Script** (`@wix/app-management` `embeddedScripts.embedScript({ parameters })`) serving `/public/attribution.js` | Wix Forms don't carry UTM data, so a site-wide script records first-touch and last-touch UTMs, landing page and referrer. On submit it beacons `{siteKey, email, attribution, page_url}`. Hidden form fields named `utm_*` are also filled and used as a fallback. |
| Create / update the HubSpot contact | **HubSpot Contacts API**: search by email, then create (with `lifecyclestage=lead`) or `PATCH` | Upsert by email. First-touch values and `lifecyclestage` are only set when empty. |
| Make attribution visible in HubSpot | **HubSpot Properties API**: `POST /crm/v3/properties/contacts/groups` + `POST /crm/v3/properties/contacts`, created on connect | Attribution lives in a "Wix integration" property group, as properties you can filter on, report on and use in lists. |

**Attribution properties written to the HubSpot contact**

| Property | Meaning |
|---|---|
| `wix_utm_source`, `wix_utm_medium`, `wix_utm_campaign`, `wix_utm_term`, `wix_utm_content` | Last touch: the visit that produced this submission. Overwritten on every submission. |
| `wix_first_utm_source`, `wix_first_utm_medium`, `wix_first_utm_campaign` | First touch: only written when empty. |
| `wix_landing_page` | First landing URL (with UTMs). Only written when empty. |
| `wix_page_url` | Page where the form was submitted. |
| `wix_referrer` | External `document.referrer`. |
| `wix_form_submitted_at` | Submission timestamp (datetime). |
| `wix_form_id` | Wix form id. |
| `wix_form_fields` | Submitted fields that don't match a HubSpot property, as `key: value` lines. |

Standard fields (`email`, `firstname`, `lastname`, `phone`) are detected from Wix Forms field keys. Any field whose key matches a writable HubSpot property name is written to that property.

**Latency:** webhook → job runs after `WEBHOOK_DEBOUNCE_MS` (default 1.5 s, so the beacon can land first) → HubSpot updated. The demo and tests measure under 1 s end to end with a short debounce.

---

## Security and connection

| Requirement | Implementation |
|---|---|
| OAuth 2.0, no API keys in the frontend | HubSpot authorization code grant: `GET app.hubspot.com/oauth/authorize` → `POST /oauth/v1/token` → `GET /oauth/v1/access-tokens/{token}` (portal id + scopes). `state` is a single-use, 10-minute, server-side nonce bound to the Wix instance (CSRF protection). |
| Secure token storage | `SecretStore` interface. Production uses **Google Secret Manager** (one secret per instance, new version on refresh, old versions destroyed). Dev uses AES-256-GCM in SQLite. Tokens are never stored in app tables. |
| Token refresh / rotation | Refreshed 5 minutes before expiry, single-flight per instance, and retried once on a 401. A rotated refresh token is persisted. |
| Disconnect | `DELETE /oauth/v1/refresh-tokens/{token}` (revoke), then delete the secret and clear the connection. Uninstall (`AppRemoved` webhook) does the same and deletes all of the site's data. |
| Least-privilege scopes | `oauth crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write`. No forms, marketing or other-object scopes. |
| Sync endpoints need auth | Dashboard API: a Wix-signed `instance` (HMAC-SHA256 with the app secret; checks `appDefId` and `signDate` age). Webhooks: Wix JWT / HubSpot signature v3. Public attribution beacon: write-only, scoped by a non-secret site key, rate-limited, sanitized. |
| Safe logging | JSON logger that deep-redacts sensitive keys and scrubs emails, bearer tokens and JWTs from every string. The database stores PII only as keyed HMAC hashes. The activity log shows ids and field names, never values. |
