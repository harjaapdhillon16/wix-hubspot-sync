/*
 * Wix ↔ HubSpot attribution capture (installed on the site as an App Embedded Script).
 *
 * 1. On every page view, remembers first-touch and last-touch UTM parameters,
 *    landing page and referrer in first-party localStorage.
 * 2. When a form is submitted, sends { email, attribution, page_url } to the app
 *    so it can be attached to the HubSpot contact created from the Wix Forms
 *    submission webhook. If the form has hidden fields named utm_source, etc., they are filled too.
 *
 * Embedded script template registered in the Wix Dev Center:
 *   <script async src="{{scriptUrl}}" data-site-key="{{siteKey}}" data-endpoint="{{endpoint}}"></script>
 */
(function () {
  var me = document.currentScript;
  var siteKey = me && me.getAttribute('data-site-key');
  var endpoint = me && me.getAttribute('data-endpoint');
  if (!siteKey || !endpoint) return;
  // Wix JSON-escapes embedded-script parameters ("https:\/\/host\/path").
  endpoint = endpoint.replace(/\\\//g, '/');

  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FIRST = 'whs_first_touch';
  var LAST = 'whs_last_touch';

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  // ---- capture touches ----
  var params = new URLSearchParams(location.search);
  var touch = {};
  UTM.forEach(function (k) { var v = params.get(k); if (v) touch[k] = v.slice(0, 200); });
  var externalReferrer = document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer : '';
  if (Object.keys(touch).length || externalReferrer) {
    touch.landing_page = location.href.slice(0, 1000);
    touch.referrer = externalReferrer.slice(0, 1000);
    touch.ts = Date.now();
    write(LAST, touch);
    if (!read(FIRST)) write(FIRST, touch);
  }

  function attribution() {
    var last = read(LAST) || {};
    var first = read(FIRST) || {};
    var out = { page_url: location.href.slice(0, 1000) };
    UTM.forEach(function (k) { if (last[k]) out[k] = last[k]; });
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (first[k]) out['first_' + k] = first[k]; });
    if (first.landing_page || last.landing_page) out.landing_page = first.landing_page || last.landing_page;
    if (last.referrer || first.referrer) out.referrer = last.referrer || first.referrer;
    return out;
  }

  function findEmail(root) {
    var inputs = root.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var hint = (el.type + ' ' + el.name + ' ' + el.id + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.autocomplete || '')).toLowerCase();
      if ((el.type === 'email' || hint.indexOf('email') !== -1) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value)) return el.value.trim();
    }
    return null;
  }

  function fillHidden(root, attr) {
    Object.keys(attr).forEach(function (k) {
      var el = root.querySelector('input[type="hidden"][name="' + k + '"], input[name^="' + k + '_"]');
      if (el && !el.value) el.value = attr[k];
    });
  }

  var lastSent = '';
  function send(root) {
    var email = findEmail(root);
    if (!email) return;
    var attr = attribution();
    fillHidden(root, attr);
    var payload = JSON.stringify({ siteKey: siteKey, email: email, attribution: attr });
    if (payload === lastSent) return; // submit + click fire for the same action
    lastSent = payload;
    try {
      if (!navigator.sendBeacon || !navigator.sendBeacon(endpoint, new Blob([payload], { type: 'text/plain' }))) {
        fetch(endpoint, { method: 'POST', body: payload, keepalive: true, mode: 'cors', headers: { 'content-type': 'text/plain' } });
      }
    } catch (e) {}
  }

  // Wix Forms render as <form> elements; listen in the capture phase so we run before navigation.
  document.addEventListener('submit', function (e) { if (e.target && e.target.querySelectorAll) send(e.target); }, true);
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('button[type="submit"], input[type="submit"], [data-hook="submit-button"]');
    if (btn) send(btn.closest('form') || document);
  }, true);
})();
