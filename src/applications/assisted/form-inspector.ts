import type { Frame, Page } from 'playwright';
import { FieldValue, FormField, FormFieldOption } from './form-field.types';

/**
 * Everything that touches the live page's DOM lives here, so the rest of the
 * assisted-apply flow can work with plain FormField objects.
 *
 * The scripts below run inside the browser, not in Node. They're kept as
 * strings (String.raw, so regex backslashes survive) and written in
 * conservative ES5-style JavaScript on purpose: if they were ordinary
 * TypeScript functions passed to page.evaluate(), the TypeScript compiler
 * could rewrite them (helpers, downleveled syntax) into code that references
 * things which don't exist in the page.
 */

// Stamps a stable data-ja-id onto every fillable control and returns one
// descriptor per logical question (radio / checkbox groups are collapsed into
// a single field with options).
const INSPECT_SCRIPT = String.raw`(function () {
  var SKIP_TYPES = { hidden: 1, submit: 1, button: 1, image: 1, reset: 1, password: 1 };
  var HONEYPOT = /honeypot|ohnohoney|bot.?field|trap|do.?not.?fill/i;
  window.__jaCounter = window.__jaCounter || 0;

  function txt(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function ownText(node) {
    var clone = node.cloneNode(true);
    var junk = clone.querySelectorAll('select, textarea, input, option, script, style');
    for (var i = 0; i < junk.length; i++) junk[i].parentNode.removeChild(junk[i]);
    return txt(clone.textContent);
  }

  function rectsVisible(el) {
    if (!el.getClientRects().length) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function isVisible(el, type) {
    if (rectsVisible(el)) {
      if (type === 'radio' || type === 'checkbox' || type === 'file') return true;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (r.right <= 0 || r.bottom <= 0) return false; // parked off-screen: classic honeypot
      return true;
    }
    if (type === 'radio' || type === 'checkbox' || type === 'file') {
      var host = el.closest('label') || el.parentElement;
      return !!host && rectsVisible(host);
    }
    return false;
  }

  function ariaHidden(el) {
    return !!el.closest('[aria-hidden="true"]');
  }

  function labelText(el) {
    var parts = [];
    var id = el.getAttribute('id');
    if (id) {
      var ls = document.querySelectorAll('label[for="' + CSS.escape(id) + '"]');
      for (var i = 0; i < ls.length; i++) parts.push(ownText(ls[i]));
    }
    if (!parts.length) {
      var wrap = el.closest('label');
      if (wrap) parts.push(ownText(wrap));
    }
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var ids = lb.split(/\s+/);
      for (var j = 0; j < ids.length; j++) {
        var n = document.getElementById(ids[j]);
        if (n) parts.push(ownText(n));
      }
    }
    var al = el.getAttribute('aria-label');
    if (al) parts.push(al);
    var t = txt(parts.join(' '));
    if (!t) t = txt(el.getAttribute('placeholder'));
    if (!t) t = txt(el.getAttribute('name') || el.getAttribute('id'));
    return t.slice(0, 240);
  }

  function groupLabel(el) {
    var fs = el.closest('fieldset');
    if (fs) {
      var lg = fs.querySelector('legend');
      if (lg && txt(lg.textContent)) return txt(lg.textContent).slice(0, 240);
    }
    var grp = el.closest('[role="radiogroup"],[role="group"]');
    if (grp) {
      var a = grp.getAttribute('aria-label');
      if (a) return txt(a).slice(0, 240);
      var lb = grp.getAttribute('aria-labelledby');
      if (lb) {
        var n = document.getElementById(lb.split(/\s+/)[0]);
        if (n) return txt(n.textContent).slice(0, 240);
      }
    }
    var node = el.parentElement;
    for (var d = 0; d < 4 && node; d++, node = node.parentElement) {
      var first = node.querySelector('input,select,textarea');
      var t = '';
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c === first || (first && c.contains && c.contains(first))) break;
        t += ' ' + (c.textContent || '');
      }
      t = txt(t);
      if (t) return t.slice(0, 240);
    }
    return '';
  }

  function isRequired(el, label) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    return /\*\s*$|\(required\)/i.test(label);
  }

  function clean(label) {
    return txt(label.replace(/\s*\*\s*$/, '').replace(/\(required\)/i, ''));
  }

  function handleFor(el) {
    var h = el.getAttribute('data-ja-id');
    if (!h) {
      window.__jaCounter += 1;
      h = 'ja' + window.__jaCounter;
      el.setAttribute('data-ja-id', h);
    }
    return h;
  }

  var forms = Array.prototype.slice.call(document.forms);
  function formKey(el) {
    var i = el.form ? forms.indexOf(el.form) : -1;
    return String(i);
  }

  var els = document.querySelectorAll('input, select, textarea');
  var out = [];
  var groups = {};
  var groupOrder = [];
  var fileCount = 0;

  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var tag = el.tagName.toLowerCase();
    var type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (tag === 'input' && SKIP_TYPES[type]) continue;
    if (el.disabled) continue;
    if (el.readOnly && type !== 'select') continue;
    if (!isVisible(el, type) || ariaHidden(el)) continue;
    if (HONEYPOT.test((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '') + ' ' + (el.className || ''))) continue;

    if (type === 'radio' || type === 'checkbox') {
      var nm = el.getAttribute('name') || '';
      var key = nm ? type + '|' + formKey(el) + '|' + nm : type + '|solo|' + handleFor(el);
      if (!groups[key]) { groups[key] = { type: type, els: [] }; groupOrder.push(key); }
      groups[key].els.push(el);
      continue;
    }

    var label = labelText(el);
    var base = {
      id: handleFor(el),
      label: clean(label),
      name: el.getAttribute('name') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      required: isRequired(el, label),
      hasValue: false
    };

    var role = (el.getAttribute('role') || '').toLowerCase();
    var popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    if (tag === 'input' && (role === 'combobox' || popup === 'listbox' || el.getAttribute('aria-autocomplete') === 'list')) {
      base.kind = 'unsupported';
      base.inputType = type;
      base.hasValue = !!el.value;
      base.note = 'Custom dropdown - check this one on the real site.';
      out.push(base);
      continue;
    }

    if (tag === 'select') {
      base.kind = 'select';
      var opts = [];
      for (var o = 0; o < el.options.length; o++) {
        var op = el.options[o];
        if (op.value === '' || op.disabled) continue;
        opts.push({ value: op.value, label: txt(op.textContent) });
      }
      base.options = opts;
      base.hasValue = el.value !== '' && el.selectedIndex > 0;
      out.push(base);
      continue;
    }

    if (tag === 'textarea') {
      base.kind = 'textarea';
      base.hasValue = !!el.value;
      out.push(base);
      continue;
    }

    if (type === 'file') {
      fileCount += 1;
      base.kind = 'file';
      base.inputType = 'file';
      base.hasValue = !!(el.files && el.files.length);
      out.push(base);
      continue;
    }

    base.kind = 'text';
    base.inputType = type;
    base.hasValue = !!el.value;
    out.push(base);
  }

  for (var g = 0; g < groupOrder.length; g++) {
    var grp = groups[groupOrder[g]];
    var members = grp.els;
    var first = members[0];
    var options = [];
    var anyChecked = false;
    for (var m = 0; m < members.length; m++) {
      var mem = members[m];
      var ml = labelText(mem);
      var mv = mem.getAttribute('value');
      options.push({ value: mv === null || mv === 'on' ? clean(ml) : mv, label: clean(ml), handle: handleFor(mem) });
      if (mem.checked) anyChecked = true;
    }
    var glabel = members.length > 1 ? groupLabel(first) : labelText(first);
    var req = false;
    for (var q = 0; q < members.length; q++) { if (members[q].required || members[q].getAttribute('aria-required') === 'true') req = true; }
    if (/\*\s*$|\(required\)/i.test(glabel)) req = true;

    out.push({
      id: handleFor(first),
      kind: grp.type === 'radio' ? 'radio' : (members.length > 1 ? 'checkbox-group' : 'checkbox'),
      inputType: grp.type,
      label: clean(glabel) || options[0].label,
      name: first.getAttribute('name') || undefined,
      required: req,
      options: members.length > 1 ? options : undefined,
      hasValue: anyChecked
    });
  }

  return { fields: out, fileCount: fileCount };
})()`;

// Finds the button that submits the application (never one that just goes to
// the next step) and tags it with data-ja-submit so it can be clicked later.
const SUBMIT_SCRIPT = String.raw`(function () {
  var nodes = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
  var prev = document.querySelectorAll('[data-ja-submit]');
  for (var p = 0; p < prev.length; p++) prev[p].removeAttribute('data-ja-submit');

  function label(n) {
    return String(n.innerText || n.value || n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  }

  var best = null, bestScore = 0, bestLabel = '', nextLabel = '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!n.getClientRects().length) continue;
    var t = label(n);
    if (!t) continue;
    var tl = t.toLowerCase();
    if (/^(next|continue|save (and|&) continue|next step)\b/.test(tl)) { if (!nextLabel) nextLabel = t; continue; }
    if (/\b(back|cancel|clear|reset|sign ?in|log ?in|search|share|linkedin|indeed|google|apple|attach|upload|add|remove|delete|close|previous|preview)\b/.test(tl) && !/\b(apply|submit)\b/.test(tl)) continue;
    var score = 0;
    if (n.getAttribute('type') === 'submit') score += 2;
    if (/\bsubmit\b/.test(tl)) score += 4;
    if (/send application|complete application|\bfinish\b/.test(tl)) score += 4;
    if (/^apply\b|apply now|apply for/.test(tl)) score += 3;
    if (n.closest('form')) score += 1;
    if (score > bestScore) { best = n; bestScore = score; bestLabel = t; }
  }
  if (best && bestScore >= 3) {
    best.setAttribute('data-ja-submit', '1');
    return { found: true, label: bestLabel, disabled: !!best.disabled, next: nextLabel };
  }
  return { found: false, next: nextLabel };
})()`;

// After pressing submit: any validation errors the site is showing?
const ERRORS_SCRIPT = String.raw`(function () {
  var out = [];
  function add(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s && s.length < 200 && out.indexOf(s) === -1) out.push(s);
  }
  var alerts = document.querySelectorAll('[role="alert"], .error, .errors, .field-error, .error-message, .invalid-feedback, [class*="error-text"], [class*="ErrorMessage"]');
  for (var i = 0; i < alerts.length && out.length < 8; i++) {
    if (alerts[i].getClientRects().length) add(alerts[i].innerText);
  }
  if (!out.length) {
    var bad = document.querySelectorAll('[aria-invalid="true"]');
    for (var j = 0; j < bad.length && out.length < 8; j++) {
      var l = bad[j].getAttribute('aria-label') || bad[j].getAttribute('name') || bad[j].getAttribute('id');
      add(l ? l + ' needs attention' : '');
    }
  }
  return out;
})()`;

const SUCCESS_TEXT =
  /thank you for (applying|your (application|interest))|application (has been |was )?(received|submitted|sent)|successfully (submitted|applied)|we('ve| have) received your application|your application (is|has been) (in|received)/i;

export interface InspectResult {
  fields: FormField[];
  fileCount: number;
}

export async function inspectForm(frame: Frame): Promise<InspectResult> {
  const raw = (await frame.evaluate(INSPECT_SCRIPT)) as { fields: any[]; fileCount: number };
  const fields: FormField[] = (raw?.fields || []).map((f) => ({
    id: String(f.id),
    kind: f.kind,
    inputType: f.inputType,
    label: String(f.label || '').slice(0, 240),
    name: f.name,
    placeholder: f.placeholder,
    autocomplete: f.autocomplete,
    required: !!f.required,
    options: Array.isArray(f.options)
      ? (f.options as FormFieldOption[]).slice(0, 200).map((o) => ({ value: String(o.value), label: String(o.label), handle: o.handle }))
      : undefined,
    hasValue: !!f.hasValue,
    note: f.note,
  }));
  return { fields, fileCount: raw?.fileCount || 0 };
}

export interface SubmitButtonInfo {
  found: boolean;
  label?: string;
  disabled?: boolean;
  /** Label of a Next/Continue button when the form is a multi-step wizard. */
  next?: string;
}

export async function findSubmitButton(frame: Frame): Promise<SubmitButtonInfo> {
  try {
    return (await frame.evaluate(SUBMIT_SCRIPT)) as SubmitButtonInfo;
  } catch {
    return { found: false };
  }
}

function sel(handle: string): string {
  return `[data-ja-id="${handle.replace(/"/g, '')}"]`;
}

export function resolveOption(field: FormField, wanted: unknown): FormFieldOption | undefined {
  const v = String(wanted ?? '').trim().toLowerCase();
  if (!v) return undefined;
  return (
    field.options?.find((o) => o.value.toLowerCase() === v) ||
    field.options?.find((o) => o.label.toLowerCase() === v)
  );
}

async function setChecked(frame: Frame, handle: string, checked: boolean): Promise<void> {
  const loc = frame.locator(sel(handle)).first();
  try {
    await loc.setChecked(checked, { timeout: 2500 });
  } catch {
    // Custom-styled controls often hide the real <input> behind a label; a
    // direct DOM click still toggles it.
    if ((await loc.isChecked().catch(() => !checked)) !== checked) {
      await loc.evaluate('el => el.click()');
    }
  }
  if ((await loc.isChecked().catch(() => !checked)) !== checked) {
    throw new Error('Could not toggle this option.');
  }
}

/**
 * Writes one answer into the live page. `value` for file fields is an
 * absolute path on this server. Throws (with a readable message) if the
 * control refused the value, so the caller can leave the field for the user.
 */
export async function fillField(frame: Frame, field: FormField, value: FieldValue): Promise<void> {
  switch (field.kind) {
    case 'text':
    case 'textarea': {
      await frame.locator(sel(field.id)).first().fill(String(value), { timeout: 4000 });
      return;
    }
    case 'select': {
      const opt = resolveOption(field, value);
      if (!opt) throw new Error(`"${String(value)}" is not one of the available options.`);
      await frame.locator(sel(field.id)).first().selectOption({ value: opt.value }, { timeout: 4000 });
      return;
    }
    case 'radio': {
      const opt = resolveOption(field, value);
      if (!opt?.handle) throw new Error(`"${String(value)}" is not one of the available options.`);
      await setChecked(frame, opt.handle, true);
      return;
    }
    case 'checkbox': {
      await setChecked(frame, field.id, value === true || String(value).toLowerCase() === 'true');
      return;
    }
    case 'checkbox-group': {
      const wanted = Array.isArray(value) ? value : [String(value)];
      const opts = wanted.map((w) => resolveOption(field, w));
      if (opts.some((o) => !o?.handle)) throw new Error('One of the chosen options is not available.');
      for (const opt of opts) await setChecked(frame, opt!.handle!, true);
      return;
    }
    case 'file': {
      await frame.locator(sel(field.id)).first().setInputFiles(String(value), { timeout: 8000 });
      return;
    }
    default:
      throw new Error('This kind of field cannot be filled automatically.');
  }
}

export type SubmitOutcome = { kind: 'success' } | { kind: 'errors'; errors: string[] } | { kind: 'unknown' };

async function pageText(target: Frame | Page): Promise<string> {
  try {
    return String(await target.evaluate('document.body ? document.body.innerText : ""'));
  } catch {
    return '';
  }
}

/** Looks at the page after a submit click and decides what happened. */
export async function detectSubmitOutcome(page: Page, frame: Frame): Promise<SubmitOutcome> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const main = page.mainFrame();
  const texts = [await pageText(main)];
  if (frame !== main && !frame.isDetached()) texts.push(await pageText(frame));
  if (texts.some((t) => SUCCESS_TEXT.test(t))) return { kind: 'success' };

  const errors: string[] = [];
  for (const f of frame !== main && !frame.isDetached() ? [frame, main] : [main]) {
    try {
      const found = (await f.evaluate(ERRORS_SCRIPT)) as string[];
      for (const e of found) if (!errors.includes(e)) errors.push(e);
    } catch {
      /* frame navigated - nothing to read */
    }
  }
  return errors.length ? { kind: 'errors', errors: errors.slice(0, 8) } : { kind: 'unknown' };
}

/** Best-effort title + visible text of the page, used to build a Job when the user pastes a link we have no record of. */
export async function readPageSummary(page: Page): Promise<{ title: string; siteName: string; text: string }> {
  try {
    const raw = (await page.evaluate(
      String.raw`(function () {
        var og = document.querySelector('meta[property="og:site_name"]');
        var t = document.body ? document.body.innerText : '';
        return { title: document.title || '', siteName: og ? og.getAttribute('content') || '' : '', text: t.replace(/\s+/g, ' ').trim().slice(0, 6000) };
      })()`,
    )) as { title: string; siteName: string; text: string };
    return raw;
  } catch {
    return { title: '', siteName: '', text: '' };
  }
}
