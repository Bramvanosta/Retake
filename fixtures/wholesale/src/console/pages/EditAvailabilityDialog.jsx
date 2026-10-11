import { useEffect, useState } from 'react';
import { Flag } from '../../shared/art.jsx';
import { Modal } from '../../shared/dialog.jsx';
import { range } from '../../shared/format.js';
import { MultiPicker } from '../../shared/pickers.jsx';
import { session } from '../../shared/session.js';
import { StatusBadge } from '../../shared/ui.jsx';

/**
 * Radix Dialog with three multi-select pickers: Bag sizes (Base UI Popover), Grind options
 * (Radix Popover) and Label languages (Base UI Popover with search). Escape closes the whole
 * dialog — Radix listens for Escape on the document, before the Base UI popover sees it.
 */
export function EditAvailabilityDialog({ product, row, onClose, onSave }) {
  const [shown, setShown] = useState(row);
  const [bags, setBags] = useState([]);
  const [grinds, setGrinds] = useState([]);
  const [labels, setLabels] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!row) return;
    setShown(row);
    setBags(row.bag_sizes);
    setGrinds(row.grind_options);
    setLabels(row.label_languages);
  }, [row]);

  const r = row ?? shown;
  const invalid = bags.length === 0 || grinds.length === 0 || labels.length === 0;

  async function save() {
    setSaving(true);
    try {
      await onSave(r, { bag_sizes: bags, grind_options: grinds, label_languages: labels });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit availability"
      description={r && product ? `${r.region} · ${product.name}` : undefined}
      footer={
        <>
          {invalid ? <span className="footer-note">Pick at least one option in each list.</span> : null}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={invalid || saving}>
            {saving ? <span className="spinner" /> : null}
            Save
          </button>
        </>
      }
    >
      {r ? (
        <>
          <div className="edit-summary">
            <Flag code={r.code} />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{r.region}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Delivery window {range(r.window_start, r.window_end)} · {r.reserved_pct}% reserved
              </div>
            </div>
            <StatusBadge status={r.status} />
          </div>
          <MultiPicker id="edit-bag-sizes" label="Bag sizes" engine="base" options={session.options.bag_sizes} value={bags} onChange={setBags} />
          <MultiPicker
            id="edit-grind-options"
            label="Grind options"
            engine="radix"
            options={session.options.grind_options}
            value={grinds}
            onChange={setGrinds}
          />
          <MultiPicker
            id="edit-label-languages"
            label="Label languages"
            engine="base"
            searchable
            options={session.options.label_languages}
            value={labels}
            onChange={setLabels}
            hint="Printed on the bag label. Add every official language of the market."
          />
        </>
      ) : null}
    </Modal>
  );
}
