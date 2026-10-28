// The shop's recording lab (GET /record-lab): one page made to test the recorder (`studio record`, L3.4) — what a
// person meets on real apps, in one place:
// - an account form whose password field switches to plain text ("Show"), a field that is re-mounted as a new
//   element holding the same value, a "reveal" that prints the password as page text, one-time-code boxes, a card
//   number, an API key field (paste), a GET form with a password (its values would land in the URL);
// - a native select, a Radix select, a Radix dialog, a table whose rows have a Radix menu (one item asks to confirm),
//   a file drop zone, a textarea and a contenteditable, a "Mark notifications read" button (a write), a link;
// - a script that tries to forge the recorder's input: synthetic events, every window function that looks like a
//   binding, the kit's and the recorder's names (it reports what it could see in `[data-testid=forge-report]`).
// - with `?hostile=1` only (L4.8): one more button whose label is markup and a direction override — the Studio's Record
//   screen must show it as inert text (the other tests film the page without the flag: their counts never move);
// - at the bottom, below a tall spacer (L4.8 review): "Far away" (a person scrolls to it: the recorder's scroll before
//   the press) and "Unlock the last step", which shows "Delayed control" (pressed after a pause: the recorder's wait first).
// Content is invented. Only "Mark notifications read" writes (POST /api/notifications/read).

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api.js';
import { Confirm, Modal } from '../../shared/dialog.jsx';
import { Icon } from '../../shared/icons.jsx';
import { Link, useLocation } from '../../shared/router.jsx';
import { SelectField } from '../../shared/select.jsx';
import { notify } from '../../shared/toast.jsx';

const ROWS = [
  { id: 'lot-a', name: 'Selowa Ridge', origin: 'Ethiopia' },
  { id: 'lot-b', name: 'Cerro Alto', origin: 'Colombia' },
  { id: 'lot-c', name: 'Kiambu Hills', origin: 'Kenya' },
];

/**
 * The hostile label (`?hostile=1`): markup that would run if a tool rendered page text as HTML, then a right-to-left
 * override — under the kit's 60 characters, so the recorder names the button by it.
 */
const HOSTILE_LABEL = `<img src=x onerror=__pwned=1>Hostile ${String.fromCharCode(0x202e)}gnp.exe`;

/** What a page script can try against a recorder: run once on load and again by the button. */
function forge() {
  const seen = [];
  const report = { found: [], called: 0, dispatched: 0, kit: typeof window.__demoStudio, verdict: typeof window.__dsrecVerdict, flush: typeof window.__dsrecFlush, raw: typeof window.__playwright__binding__ };
  for (const name of Object.getOwnPropertyNames(window)) {
    let v;
    try {
      v = window[name];
    } catch {
      continue;
    }
    if (typeof v !== 'function' || !/dsrec|binding|playwright|demo|record/i.test(name)) continue;
    seen.push(name);
    const forged = { k: 'ev', age: 0, path: '/record-lab', e: { kind: 'pointer', button: 'left', via: 'pointer', el: null, quiet_ms: 0, ms: 0, forged: 'FORGED-CALL' } };
    try {
      v(JSON.stringify(forged));
      v(JSON.stringify({ name, seq: 1, serializedArgs: [JSON.stringify(forged)] }));
      report.called++;
    } catch {
      /* not callable that way */
    }
  }
  report.found = seen;
  const field = document.querySelector('#lab-email');
  if (field) {
    field.value = 'FORGED-TEXT';
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'FORGED-TEXT' }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    report.dispatched += 3;
  }
  const button = document.querySelector('#lab-forge-target');
  if (button) {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    report.dispatched += 2;
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(new Event('__demo_studio_ping'));
  report.dispatched += 3;
  return report;
}

function OtpBoxes() {
  const refs = useRef([]);
  return (
    <div className="lab-otp" role="group" aria-label="Verification code">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          className="input lab-otp-box"
          inputMode="numeric"
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          onInput={(e) => {
            if (e.currentTarget.value && refs.current[i + 1]) refs.current[i + 1].focus();
          }}
        />
      ))}
    </div>
  );
}

function RowMenu({ row, onArchive }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-btn" aria-label="Row actions">
        <Icon name="more" size={18} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="floating" align="end" sideOffset={6} style={{ width: 200 }}>
          <DropdownMenu.Item className="menu-item" onSelect={() => notify({ title: 'Lot duplicated', description: row.name })}>
            <Icon name="copy" size={16} />
            Duplicate
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => onArchive(row)}>
            <Icon name="x" size={16} />
            Archive
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RecordLabPage() {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState('');
  const [remount, setRemount] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [bag, setBag] = useState(undefined);
  const [roast, setRoast] = useState('medium');
  const [dialog, setDialog] = useState(false);
  const [archive, setArchive] = useState(null);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [late, setLate] = useState(false);
  const hostile = useLocation().search.get('hostile') === '1';

  useEffect(() => {
    const t = setTimeout(() => setReport(forge()), 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="lab">
      <h1 className="page-title">Recording lab</h1>
      <div className="lab-grid">
        <section className="card card-pad">
          <h2 className="section-title">Account</h2>
          <div className="field">
            <label className="field-label" htmlFor="lab-email">
              Email
            </label>
            <input id="lab-email" className="input" type="email" autoComplete="off" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={remount ? 'lab-field' : 'lab-password'}>
              {remount ? 'Field' : 'Password'}
            </label>
            <div className="row">
              {/* "Re-mount": a new element (key) holding the same value, without the password type. */}
              <input
                key={remount}
                id={remount ? 'lab-field' : 'lab-password'}
                className="input"
                type={show || remount ? 'text' : 'password'}
                name={remount ? 'field' : 'password'}
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShow((s) => !s)}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemount((n) => n + 1)}>
              Re-mount the field
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevealed(true)}>
              Reveal
            </button>
          </div>
          {revealed ? (
            <p className="lab-revealed">
              <button type="button" className="link">
                {password}
              </button>
            </p>
          ) : null}
          <div className="field">
            <span className="field-label">Verification code</span>
            <OtpBoxes />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="lab-card">
              Card
            </label>
            <input id="lab-card" className="input" autoComplete="cc-number" inputMode="numeric" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="lab-key">
              Integration
            </label>
            <input id="lab-key" className="input" name="apiKey" placeholder="Paste your key" autoComplete="off" />
          </div>
        </section>

        <section className="card card-pad">
          <h2 className="section-title">Order</h2>
          <div className="field">
            <label className="field-label" htmlFor="lab-roast">
              Roast level
            </label>
            <select id="lab-roast" className="input" value={roast} onChange={(e) => setRoast(e.target.value)}>
              <option value="light">Light</option>
              <option value="medium">Medium</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <SelectField
            id="lab-bag"
            label="Bag size"
            value={bag}
            onValueChange={setBag}
            options={[
              { value: '1kg', label: '1 kg' },
              { value: '5kg', label: '5 kg' },
              { value: '10kg', label: '10 kg' },
            ]}
          />
          <div className="field">
            <label className="field-label" htmlFor="lab-note">
              Note
            </label>
            <textarea id="lab-note" className="textarea" rows={2} />
          </div>
          <div className="field">
            <span className="field-label" id="lab-message-label">
              Message
            </span>
            <div className="input lab-editable" contentEditable suppressContentEditableWarning role="textbox" aria-labelledby="lab-message-label" />
          </div>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={() => setDialog(true)}>
              Edit address
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => api.post('/api/notifications/read', {}).then(() => notify({ title: 'Notifications marked read' }), () => notify({ title: 'Could not mark them read' }))}
            >
              Mark notifications read
            </button>
          </div>
          <label className="dropzone lab-drop" data-has-file={file ? true : undefined}>
            <input type="file" className="visually-hidden" onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
            <span className="dz-title">{file ? `Attached: ${file}` : 'Drop a price list here'}</span>
          </label>
          <p>
            <Link to="/coffees">Browse coffees</Link>
          </p>
        </section>

        <section className="card card-pad">
          <h2 className="section-title">Lots</h2>
          <table className="table">
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.origin}</td>
                  <td>
                    <RowMenu row={r} onArchive={setArchive} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form method="get" action="/record-lab/results" className="stack">
            <h2 className="section-title">Legacy sign-in (GET)</h2>
            <input className="input" name="user" aria-label="Legacy user" autoComplete="off" />
            <input className="input" name="password" type="password" aria-label="Legacy password" autoComplete="off" />
            <button type="submit" className="btn btn-secondary">
              Legacy sign in
            </button>
          </form>
          <h2 className="section-title">Forgery</h2>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={() => setReport(forge())}>
              Run the forgery script
            </button>
            <button id="lab-forge-target" type="button" className="btn btn-ghost btn-sm">
              Forgery target
            </button>
          </div>
          {hostile ? (
            <p>
              <button id="lab-hostile" type="button" className="btn btn-secondary btn-sm">
                {HOSTILE_LABEL}
              </button>
            </p>
          ) : null}
          <pre data-testid="forge-report" className="lab-report">
            {report ? JSON.stringify(report) : ''}
          </pre>
        </section>
      </div>

      <section className="card card-pad lab-far">
        <div aria-hidden="true" style={{ height: 1600 }} />
        <h2 className="section-title">Further down</h2>
        <p className="lab-row">
          <button id="lab-far" type="button" className="btn btn-secondary btn-sm" data-testid="lab-far" onClick={() => notify({ title: 'Far away pressed' })}>
            Far away
          </button>{' '}
          <button id="lab-reveal" type="button" className="btn btn-secondary btn-sm" onClick={() => setLate(true)}>
            Unlock the last step
          </button>{' '}
          {late ? (
            <button id="lab-late" type="button" className="btn btn-primary btn-sm" onClick={() => notify({ title: 'Delayed control pressed' })}>
              Delayed control
            </button>
          ) : null}
        </p>
      </section>

      <Modal
        open={dialog}
        onOpenChange={setDialog}
        title="Edit address"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setDialog(false)}>
            Save address
          </button>
        }
      >
        <div className="field">
          <label className="field-label" htmlFor="lab-street">
            Street
          </label>
          <input id="lab-street" className="input" />
        </div>
      </Modal>
      <Confirm
        open={archive !== null}
        onOpenChange={(o) => !o && setArchive(null)}
        title="Archive this lot?"
        description={archive ? archive.name : ''}
        confirmLabel="Archive lot"
        onConfirm={() => {
          notify({ title: 'Lot archived', description: archive?.name });
          setArchive(null);
        }}
      />
    </div>
  );
}
