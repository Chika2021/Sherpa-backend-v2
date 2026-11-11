/*!
 * Sherpar widget - one <script> tag adds:
 *   1. a "Contact us" form wherever you place <div id="sherpar-contact"></div>   (homepage)
 *   2. a floating chat button with the AI assistant + the user Helpdesk (on every page)
 *
 *   <div id="sherpar-contact"></div>
 *   <script src="https://YOUR-API-HOST/widget/sherpar-widget.js"
 *           data-token-key="accessToken"      // localStorage key where your app keeps the login JWT
 *           data-app-url="https://YOUR-APP"   // base for links the chatbot shows (default: current site)
 *           defer></script>
 *
 * Optional: data-api (default: <script origin>/api/v1), data-contact-target (CSS selector),
 *           data-brand-color (default #4f46e5), data-chat="false" to hide the chat button.
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[src*="sherpar-widget"]');
  var ds = (script && script.dataset) || {};
  var API = (ds.api || (script ? new URL(script.src).origin + '/api/v1' : '/api/v1')).replace(/\/$/, '');
  var APP = (ds.appUrl || location.origin).replace(/\/$/, '');
  var BRAND = ds.brandColor || '#4f46e5';
  var TOKEN_KEYS = ds.tokenKey ? [ds.tokenKey] : ['accessToken', 'token', 'access_token', 'jwt', 'authToken'];

  function getToken() {
    var stores = [localStorage, sessionStorage];
    for (var s = 0; s < stores.length; s++) {
      for (var i = 0; i < TOKEN_KEYS.length; i++) {
        try {
          var v = stores[s].getItem(TOKEN_KEYS[i]);
          if (!v) continue;
          if (v[0] === '{') { var o = JSON.parse(v); v = o.accessToken || o.token || ''; }
          v = String(v).replace(/^"|"$/g, '');
          if (v.split('.').length === 3) return v;
        } catch (e) {}
      }
    }
    return null;
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var t = opts.auth ? getToken() : null;
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var m = d.message; throw new Error(Array.isArray(m) ? m.join(', ') : m || 'Something went wrong'); }
          return d;
        });
      });
  }

  // tiny, XSS-safe element builder: text always goes in as text nodes
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    for (var k in props) {
      if (k === 'class') el.className = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== undefined && props[k] !== null) el.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  var CSS = [
    ':host{all:initial;--b:' + BRAND + ';font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f2a}',
    '*{box-sizing:border-box;font-family:inherit}',
    'button{font:inherit;cursor:pointer}',
    '.f{display:grid;gap:12px;background:#fff;border:1px solid #e5e7ee;border-radius:14px;padding:22px;max-width:560px}',
    '.f h3{margin:0;font-size:20px}.f p{margin:0;color:#6b7280}',
    'input,textarea{width:100%;border:1px solid #d6d9e3;border-radius:9px;padding:10px 12px;font:inherit;background:#fff;color:#1b1f2a}',
    'textarea{min-height:110px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--b);outline-offset:-1px}',
    '.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:520px){.row{grid-template-columns:1fr}}',
    '.btn{background:var(--b);color:#fff;border:0;border-radius:9px;padding:10px 16px;font-weight:600}.btn:disabled{opacity:.55;cursor:default}',
    '.ghost{background:none;color:var(--b);border:1px solid var(--b)}',
    '.ok{color:#15803d;background:#dcfce7;border-radius:9px;padding:10px 12px}.er{color:#b91c1c;background:#fee2e2;border-radius:9px;padding:10px 12px}',
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
    '.fab{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:var(--b);color:#fff;font-size:26px;box-shadow:0 8px 24px #0004;z-index:2147483000}',
    '.fab .n{position:absolute;top:-2px;right:-2px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;border-radius:10px;padding:1px 6px}',
    '.panel{position:fixed;right:20px;bottom:90px;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 16px 48px #0004;display:flex;flex-direction:column;overflow:hidden;z-index:2147483000;border:1px solid #e5e7ee}',
    '.hd{background:var(--b);color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}.hd b{font-size:15px}.hd button{background:none;border:0;color:#fff;font-size:20px}',
    '.tabs{display:flex;border-bottom:1px solid #e5e7ee}.tabs button{flex:1;background:none;border:0;padding:10px;font-weight:600;color:#6b7280;border-bottom:2px solid transparent}.tabs button.on{color:var(--b);border-color:var(--b)}',
    '.bd{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f7f8fb}',
    '.m{max-width:86%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word}',
    '.m.bot,.m.ADMIN{background:#fff;border:1px solid #e5e7ee;align-self:flex-start}.m.user,.m.CUSTOMER{background:var(--b);color:#fff;align-self:flex-end}',
    '.m small{display:block;opacity:.65;font-size:11px;margin-bottom:2px}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{background:#fff;border:1px solid var(--b);color:var(--b);border-radius:99px;padding:4px 11px;font-size:13px}',
    'a.lk{display:inline-block;margin-top:6px;color:var(--b);font-weight:600;text-decoration:none}a.lk:hover{text-decoration:underline}',
    '.ft{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7ee;background:#fff}.ft input{flex:1}',
    '.tk{background:#fff;border:1px solid #e5e7ee;border-radius:10px;padding:10px 12px;text-align:left;width:100%}.tk:hover{border-color:var(--b)}',
    '.tk b{display:block}.tk span{color:#6b7280;font-size:12px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;margin-right:6px}',
    '.pad{padding:14px;display:grid;gap:10px;align-content:start;overflow:auto;flex:1;background:#f7f8fb}',
    '.typing{opacity:.6;font-style:italic}',
  ].join('\n');

  function mountRoot() {
    var host = h('div');
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style')).textContent = CSS;
    return { host: host, root: root };
  }

  /* ---------- reusable contact form ---------- */
  function contactForm(opts) {
    opts = opts || {};
    var name = h('input', { placeholder: 'Your name', required: '', maxlength: '100', autocomplete: 'name' });
    var email = h('input', { type: 'email', placeholder: 'Email address', required: '', maxlength: '200', autocomplete: 'email' });
    var subject = h('input', { placeholder: 'Subject (optional)', maxlength: '200' });
    var message = h('textarea', { placeholder: 'How can we help?', required: '', maxlength: '5000' });
    if (opts.message) message.value = opts.message;
    var hp = h('input', { class: 'hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', name: 'website' });
    var status = h('div');
    var btn = h('button', { class: 'btn', type: 'submit' }, 'Send message');
    var form = h('form', { class: opts.compact ? 'pad' : 'f', novalidate: '' },
      opts.compact ? null : h('h3', {}, opts.title || 'Contact us'),
      opts.compact ? null : h('p', {}, opts.intro || "Questions, feedback or need help? Send us a message and we'll reply by email."),
      h('div', { class: 'row' }, name, email), subject, message, hp, btn, status);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = ''; status.textContent = '';
      if (name.value.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email.value) || message.value.trim().length < 10) {
        status.className = 'er'; status.textContent = 'Please enter your name, a valid email and a message of at least 10 characters.'; return;
      }
      btn.disabled = true; btn.textContent = 'Sending…';
      api('/support/contact', { method: 'POST', body: { name: name.value.trim(), email: email.value.trim(), subject: subject.value.trim() || undefined, message: message.value.trim(), website: hp.value } })
        .then(function (r) { status.className = 'ok'; status.textContent = r.message || 'Message sent. Thank you!'; form.querySelectorAll('input:not(.hp),textarea').forEach(function (el) { el.value = ''; }); })
        .catch(function (err) { status.className = 'er'; status.textContent = err.message; })
        .then(function () { btn.disabled = false; btn.textContent = 'Send message'; });
    });
    return form;
  }

  /* ---------- 1. homepage contact section ---------- */
  function initContact() {
    var target = document.querySelector(ds.contactTarget || '#sherpar-contact');
    if (!target || target.dataset.sherpar) return;
    target.dataset.sherpar = '1';
    var m = mountRoot();
    m.root.appendChild(contactForm());
    target.appendChild(m.host);
  }

  /* ---------- 2. chat + helpdesk ---------- */
  function initChat() {
    if (ds.chat === 'false') return;
    var m = mountRoot(), root = m.root;
    var open = false, tab = 'bot', transcript = [], booted = false, unread = 0;

    var badge = h('span', { class: 'n', style: 'display:none' });
    var fab = h('button', { class: 'fab', 'aria-label': 'Chat with us', onclick: toggle }, '💬', badge);
    var panel = h('div', { class: 'panel', style: 'display:none', role: 'dialog', 'aria-label': 'Support chat' });
    root.appendChild(fab); root.appendChild(panel);
    document.body.appendChild(m.host);

    function setUnread(n) { unread = n; badge.textContent = n; badge.style.display = n ? '' : 'none'; }
    function refreshUnread() {
      if (!getToken()) return setUnread(0);
      api('/support/tickets/unread-count', { auth: true }).then(function (r) { setUnread(r.unread || 0); }).catch(function () {});
    }
    refreshUnread(); setInterval(refreshUnread, 60000);

    function toggle() { open = !open; panel.style.display = open ? 'flex' : 'none'; if (open) { render(); } }

    function render() {
      panel.textContent = '';
      panel.appendChild(h('div', { class: 'hd' }, h('b', {}, 'Sherpar Support'), h('button', { onclick: toggle, 'aria-label': 'Close' }, '×')));
      panel.appendChild(h('div', { class: 'tabs' },
        h('button', { class: tab === 'bot' ? 'on' : '', onclick: function () { tab = 'bot'; render(); } }, 'Assistant'),
        h('button', { class: tab === 'desk' ? 'on' : '', onclick: function () { tab = 'desk'; deskView = 'list'; render(); } }, 'Helpdesk' + (unread ? ' (' + unread + ')' : ''))));
      (tab === 'bot' ? botView : deskViewRender)();
    }

    /* --- assistant --- */
    var botBody, botInput;
    function bubble(role, text, extra) {
      var b = h('div', { class: 'm ' + role }, text);
      if (extra && extra.links) extra.links.forEach(function (l) { b.appendChild(h('br')); b.appendChild(h('a', { class: 'lk', href: APP + l.path, target: '_blank', rel: 'noopener' }, l.label + ' →')); });
      botBody.appendChild(b);
      if (extra && extra.suggestions && extra.suggestions.length) {
        var chips = h('div', { class: 'chips' });
        extra.suggestions.forEach(function (s) { chips.appendChild(h('button', { class: 'chip', onclick: function () { send(s); } }, s)); });
        botBody.appendChild(chips);
      }
      if (extra && extra.handoff) botBody.appendChild(h('button', { class: 'btn', onclick: function () { handoff(); } }, 'Contact support team'));
      botBody.scrollTop = botBody.scrollHeight;
      return b;
    }
    function botView() {
      botBody = h('div', { class: 'bd' });
      botInput = h('input', { placeholder: 'Ask me anything…', maxlength: '600', onkeydown: function (e) { if (e.key === 'Enter') { send(botInput.value); } } });
      panel.appendChild(botBody);
      panel.appendChild(h('div', { class: 'ft' }, botInput, h('button', { class: 'btn', onclick: function () { send(botInput.value); } }, 'Send')));
      if (!transcript.length) {
        api('/chatbot/welcome').then(function (w) { bubble('bot', w.reply, { suggestions: w.suggestions }); transcript.push({ role: 'bot', text: w.reply }); })
          .catch(function () { bubble('bot', 'Hi! How can I help?'); });
      } else {
        transcript.forEach(function (t) { bubble(t.role, t.text, t.extra); });
      }
      setTimeout(function () { botInput.focus(); }, 50);
    }
    function send(text) {
      text = (text || '').trim(); if (!text) return;
      botInput.value = '';
      transcript.push({ role: 'user', text: text }); bubble('user', text);
      var typing = bubble('bot typing', 'Typing…');
      var history = transcript.slice(-9, -1).map(function (t) { return { role: t.role, text: t.text.slice(0, 1500) }; });
      api('/chatbot/message', { method: 'POST', body: { message: text, history: history } })
        .then(function (r) { typing.remove(); var extra = { links: r.links, suggestions: r.suggestions, handoff: r.handoff }; transcript.push({ role: 'bot', text: r.reply, extra: extra }); bubble('bot', r.reply, extra); })
        .catch(function (e) { typing.remove(); bubble('bot', e.message || "Sorry, I couldn't answer that right now.", { handoff: true }); });
    }
    function handoff() {
      var last = transcript.filter(function (t) { return t.role === 'user'; }).map(function (t) { return t.text; }).slice(-3).join('\n');
      deskDraft = last ? 'From the chat assistant:\n' + last + '\n\n' : '';
      tab = 'desk'; deskView = 'new'; render();
    }

    /* --- helpdesk --- */
    var deskView = 'list', deskDraft = '', openTicketId = null;
    function deskViewRender() {
      if (!getToken()) {
        panel.appendChild(h('div', { class: 'pad' }, h('p', { style: 'margin:0;color:#6b7280' }, 'Send us a message and we will reply by email. Log in to see replies right here.'), contactForm({ compact: true, message: deskDraft })));
        return;
      }
      if (deskView === 'new') return newTicketView();
      if (deskView === 'thread') return threadView();
      listView();
    }
    function listView() {
      var body = h('div', { class: 'pad' }, h('button', { class: 'btn', onclick: function () { deskView = 'new'; render(); } }, '+ New request'));
      panel.appendChild(body);
      body.appendChild(h('p', { class: 'typing', style: 'margin:0' }, 'Loading…'));
      api('/support/tickets', { auth: true }).then(function (list) {
        body.lastChild.remove();
        if (!list.length) body.appendChild(h('p', { style: 'margin:0;color:#6b7280' }, 'No requests yet. Start one and our team will reply here.'));
        list.forEach(function (t) {
          body.appendChild(h('button', { class: 'tk', onclick: function () { openTicketId = t.id; deskView = 'thread'; render(); } },
            h('b', {}, t.unreadByUser ? h('i', { class: 'dot' }) : null, t.subject),
            h('span', {}, t.status + ' · ' + new Date(t.updatedAt).toLocaleDateString())));
        });
      }).catch(function (e) { body.lastChild.textContent = e.message; });
    }
    function newTicketView() {
      var subject = h('input', { placeholder: 'Subject', maxlength: '200' });
      var msg = h('textarea', { placeholder: 'Describe your issue or question…', maxlength: '5000' }); msg.value = deskDraft;
      var status = h('div'), btn = h('button', { class: 'btn' }, 'Send request');
      btn.addEventListener('click', function () {
        if (subject.value.trim().length < 3 || msg.value.trim().length < 5) { status.className = 'er'; status.textContent = 'Please add a subject and a message.'; return; }
        btn.disabled = true;
        api('/support/tickets', { method: 'POST', auth: true, body: { subject: subject.value.trim(), message: msg.value.trim(), source: deskDraft ? 'CHATBOT' : 'HELPDESK' } })
          .then(function (r) { deskDraft = ''; openTicketId = r.ticket.id; deskView = 'thread'; render(); })
          .catch(function (e) { status.className = 'er'; status.textContent = e.message; btn.disabled = false; });
      });
      panel.appendChild(h('div', { class: 'pad' }, h('button', { class: 'ghost btn', onclick: function () { deskView = 'list'; render(); } }, '← Back'), subject, msg, btn, status));
    }
    function threadView() {
      var body = h('div', { class: 'bd' }, h('p', { class: 'typing' }, 'Loading…'));
      var input = h('input', { placeholder: 'Write a reply…', maxlength: '5000' });
      var sendBtn = h('button', { class: 'btn' }, 'Send');
      panel.appendChild(h('div', { style: 'padding:8px 10px;border-bottom:1px solid #e5e7ee' }, h('button', { class: 'ghost btn', onclick: function () { deskView = 'list'; render(); } }, '← Back')));
      panel.appendChild(body);
      panel.appendChild(h('div', { class: 'ft' }, input, sendBtn));
      function load() {
        api('/support/tickets/' + openTicketId, { auth: true }).then(function (r) {
          body.textContent = '';
          body.appendChild(h('b', {}, r.ticket.subject));
          r.messages.forEach(function (x) { body.appendChild(h('div', { class: 'm ' + x.sender }, h('small', {}, (x.sender === 'ADMIN' ? x.senderName + ' (Support)' : 'You') + ' · ' + new Date(x.createdAt).toLocaleString()), x.body)); });
          if (r.ticket.status === 'CLOSED') body.appendChild(h('p', { style: 'color:#6b7280;margin:0' }, 'This request is closed. Reply to reopen it.'));
          body.scrollTop = body.scrollHeight; refreshUnread();
        }).catch(function (e) { body.textContent = e.message; });
      }
      sendBtn.addEventListener('click', function () {
        var t = input.value.trim(); if (!t) return; sendBtn.disabled = true;
        api('/support/tickets/' + openTicketId + '/reply', { method: 'POST', auth: true, body: { body: t } })
          .then(function () { input.value = ''; load(); }).catch(function (e) { body.appendChild(h('div', { class: 'er' }, e.message)); })
          .then(function () { sendBtn.disabled = false; });
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendBtn.click(); });
      load();
    }
  }

  function boot() { initContact(); initChat(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
