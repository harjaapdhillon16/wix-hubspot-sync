/**
 * `npm run dev:mock` — a fully local, credential-free demo of the whole integration:
 *
 *   http://localhost:3000/dashboard/?instance=…  the real app dashboard (as Wix would iframe it)
 *   http://localhost:4010/_ui                    mock HubSpot CRM (edit contacts "in HubSpot")
 *   http://localhost:4020                        mock Wix site: a form page with the real attribution
 *                                                script + a "Wix Contacts" admin to edit contacts "in Wix"
 */
import express, { urlencoded } from 'express';
import { startStack } from './stack.js';
import type { WixContactInfo } from '../src/server/wix/fields.js';

const s = await startStack({ port: 3000, hubspotPort: 4010, debounceMs: 800 });
const site = express();
site.use(urlencoded({ extended: false }));

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const layout = (title: string, body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}
<style>body{font-family:system-ui;margin:0;color:#20303c}header{background:#116dff;color:#fff;padding:14px 24px}main{padding:24px;max-width:980px;margin:auto}
input,select{padding:6px;margin:2px}button{background:#116dff;color:#fff;border:0;padding:8px 14px;border-radius:18px;cursor:pointer}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #dfe5eb;padding:4px 6px}a{color:#116dff}</style></head>
<body><header><b>Mock Wix site</b> &nbsp;·&nbsp; <a style="color:#fff" href="/">Landing</a> · <a style="color:#fff" href="/contact">Contact form</a> · <a style="color:#fff" href="/admin">Wix Contacts (site owner)</a></header><main>${body}</main></body></html>`;

// The App Embedded Script, rendered with the parameters the app registered via embedScript().
const embed = () => {
  const p = s.wix.embedded.get(s.instanceId);
  return p ? `<script async src="${p.scriptUrl}" data-site-key="${p.siteKey}" data-endpoint="${p.endpoint}"></script>` : '';
};

site.get('/', (_req, res) => {
  res.send(layout('Landing', `<h1>Welcome</h1><p>Visitors arrive from campaigns with UTM parameters, e.g.
    <a href="/?utm_source=google&utm_medium=cpc&utm_campaign=spring_sale&utm_term=crm+software&utm_content=ad_a">this Google ad link</a>
    or <a href="/?utm_source=newsletter&utm_medium=email&utm_campaign=october">this newsletter link</a>.</p>
    <p>The attribution script ${embed() ? '<b>is installed</b> on this site' : 'is <b>not installed yet</b> (connect HubSpot first)'}. Then go to the <a href="/contact">contact form</a>.</p>`, embed()));
});

site.get('/contact', (req, res) => {
  res.send(layout('Contact', `<h1>Contact us</h1>${req.query.sent ? '<p style="color:green"><b>Thanks! Your message was sent.</b></p>' : ''}
    <form method="post" action="/contact" data-hook="wix-form">
      <div><input name="first_name_a1b2" placeholder="First name" required> <input name="last_name_c3d4" placeholder="Last name"></div>
      <div><input type="email" name="email_e5f6" placeholder="Email" required> <input name="phone_7a8b" placeholder="Phone"></div>
      <div><select name="company_size_9c0d"><option>1-10</option><option>11-50</option><option>51-200</option></select>
      <input name="message_1e2f" placeholder="Message" size="40"></div>
      <button type="submit">Submit</button>
    </form>`, embed()));
});

site.post('/contact', (req, res) => {
  const b = req.body as Record<string, string>;
  const info: WixContactInfo = { name: { first: b.first_name_a1b2, last: b.last_name_c3d4 }, emails: { items: [{ email: b.email_e5f6, tag: 'MAIN', primary: true }] } };
  if (b.phone_7a8b) info.phones = { items: [{ phone: b.phone_7a8b, tag: 'MOBILE', primary: true }] };
  s.wix.submitForm(s.instanceId, 'contact-form-1', b, info);
  res.redirect('/contact?sent=1');
});

site.get('/admin', (_req, res) => {
  const rows = s.wix.allContacts(s.instanceId).map((c) => `<tr><td><code>${esc(c._id?.slice(0, 8))}</code></td>
    <td><form method="post" action="/admin" style="display:flex;gap:4px"><input type="hidden" name="id" value="${esc(c._id)}">
    <input name="email" value="${esc(c.primaryInfo?.email)}" size="18"><input name="first" value="${esc(c.info?.name?.first)}" size="8"><input name="last" value="${esc(c.info?.name?.last)}" size="8">
    <input name="phone" value="${esc(c.primaryInfo?.phone)}" size="10" placeholder="phone"><input name="company" value="${esc(c.info?.company)}" size="10" placeholder="company">
    <input name="jobTitle" value="${esc(c.info?.jobTitle)}" size="10" placeholder="job title"><button>Save</button></form></td><td>rev ${c.revision}</td></tr>`).join('');
  res.send(layout('Wix Contacts', `<h1>Wix Contacts</h1><p>Edits here behave like the site owner editing contacts in the Wix dashboard (webhooks identity = WIX_USER).</p>
    <table><tr><th>id</th><th>fields</th><th></th></tr>${rows}</table>
    <h3>New contact</h3><form method="post" action="/admin"><input name="email" placeholder="email" required><input name="first" placeholder="first"><input name="last" placeholder="last">
    <input name="company" placeholder="company"><button>Create</button></form>`, '<meta http-equiv="refresh" content="10">'));
});

site.post('/admin', (req, res) => {
  const b = req.body as Record<string, string>;
  const cur = b.id ? s.wix.contacts.get(`${s.instanceId}/${b.id}`) : undefined;
  const info: WixContactInfo = { name: { first: b.first ?? '', last: b.last ?? '' }, company: b.company || null, jobTitle: b.jobTitle || null };
  if (b.email) info.emails = { items: [{ ...(cur?.info?.emails?.items?.[0] ?? { tag: 'MAIN', primary: true }), email: b.email }] };
  if (b.phone !== undefined) info.phones = { items: b.phone ? [{ phone: b.phone, tag: 'MOBILE', primary: true }] : [] };
  s.wix.userUpsert(s.instanceId, info, b.id || undefined);
  res.redirect('/admin');
});

site.listen(4020, () => {
  console.log(`
  ┌───────────────────────────────────────────────────────────────────────────────
  │ Wix ↔ HubSpot mock stack is running
  │
  │ Dashboard (as embedded in Wix): ${s.cfg.APP_BASE_URL}/dashboard/?instance=${s.instance()}
  │ Mock HubSpot CRM:               ${s.hubspot.url}/_ui
  │ Mock Wix site + contacts admin: http://localhost:4020
  └───────────────────────────────────────────────────────────────────────────────
`);
});
