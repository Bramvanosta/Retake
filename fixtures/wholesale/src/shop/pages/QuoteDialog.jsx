import { NumberField } from '@base-ui/react/number-field';
import { useEffect, useState } from 'react';
import { api } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { Modal } from '../../shared/dialog.jsx';
import { eur, num } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { navigate } from '../../shared/router.jsx';
import { SelectField } from '../../shared/select.jsx';
import { session, today } from '../../shared/session.js';
import { notify } from '../../shared/toast.jsx';
import { DateRangeField } from './DateRangeField.jsx';

const LEAD_DAYS = 21;
const KG = { '250 g': 0.25, '1 kg': 1, '5 kg': 5, '20 kg': 20 };

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * "Request a quote": Radix Dialog with a Base UI NumberField (bags), Radix Selects (bag size,
 * grind, label language), a Base UI Popover calendar (delivery window) and a message.
 */
export function QuoteDialog({ product, market, open, onOpenChange }) {
  const languages = [...new Set([...(market?.label_languages ?? []), 'English'])];
  const defaultLanguage = languages[0];
  const [bags, setBags] = useState(1);
  const [bagSize, setBagSize] = useState(undefined);
  const [grind, setGrind] = useState(undefined);
  const [language, setLanguage] = useState(defaultLanguage);
  const [dates, setDates] = useState({ start: null, end: null });
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) return undefined;
    const t = setTimeout(() => {
      setBags(1);
      setBagSize(undefined);
      setGrind(undefined);
      setLanguage(defaultLanguage);
      setDates({ start: null, end: null });
      setMessage('');
      setError(null);
    }, 200);
    return () => clearTimeout(t);
  }, [open, defaultLanguage]);

  const minDate = [addDays(today, LEAD_DAYS), market?.window_start ?? today].sort().at(-1);
  const kg = bagSize ? bags * KG[bagSize] : 0;
  const estimate = bagSize ? kg * product.prices[bagSize] : 0;
  const ready = bags >= 1 && bagSize && grind && language && dates.start && dates.end;

  async function send() {
    setSending(true);
    setError(null);
    try {
      const quote = await api.post('/api/quotes', {
        product_slug: product.slug,
        bags,
        bag_size: bagSize,
        grind,
        label_language: language,
        window_start: dates.start,
        window_end: dates.end,
        message,
      });
      onOpenChange(false);
      notify({
        title: 'Quote request sent',
        description: `${product.name} · ${bags} × ${bagSize}. ${quote.supplier} usually replies within a few hours.`,
        action: { label: 'View request', onClick: () => navigate(`/quotes/${quote.id}`) },
      });
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Request a quote"
      description="The roaster replies with a priced proposal for your quantity and delivery window."
      footer={
        <>
          <div className="quote-total">
            <b>{bagSize ? `${bags} × ${bagSize} · ${num(kg, kg % 1 ? 2 : 0)} kg` : `${bags} bag${bags > 1 ? 's' : ''}`}</b>
            <span>{bagSize ? `Estimated ${eur(estimate)} excl. VAT & delivery` : 'Choose a bag size to see an estimate'}</span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready || sending} onClick={send}>
            {sending ? <span className="spinner" /> : <Icon name="arrowRight" size={16} />}
            Send request
          </button>
        </>
      }
    >
      <div className="quote-product">
        <CoffeeArt palette={product.palette} seed={product.slug} beansCount={0} variant="crop" />
        <div className="grow">
          <div style={{ fontWeight: 650 }}>{product.name}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {product.organization?.name ?? 'Northfield Roasters'} · {product.origin} · ships to {session.buyer.country}
          </div>
        </div>
        <span className="badge badge-green">
          <span className="dot" />
          Available
        </span>
      </div>

      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="quote-bags">
            Number of bags
          </label>
          <NumberField.Root id="quote-bags" value={bags} onValueChange={(v) => setBags(Math.max(1, Math.round(v ?? 1)))} min={1} max={40}>
            <NumberField.Group className="stepper">
              <NumberField.Decrement aria-label="Decrease">
                <Icon name="minus" size={16} strokeWidth={2.2} />
              </NumberField.Decrement>
              <NumberField.Input />
              <NumberField.Increment aria-label="Increase">
                <Icon name="plus" size={16} strokeWidth={2.2} />
              </NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
        </div>
        <SelectField
          id="quote-bag-size"
          label="Bag size"
          placeholder="Choose a size"
          value={bagSize}
          onValueChange={setBagSize}
          options={(market?.bag_sizes ?? []).map((s) => ({ value: s, label: s, sub: `${eur(product.prices[s])} / kg` }))}
        />
        <SelectField
          id="quote-grind"
          label="Grind"
          placeholder="Choose a grind"
          value={grind}
          onValueChange={setGrind}
          options={(market?.grind_options ?? []).map((g) => ({ value: g, label: g }))}
        />
        <SelectField
          id="quote-label-language"
          label="Label language"
          value={language}
          onValueChange={setLanguage}
          options={languages.map((l) => ({ value: l, label: l }))}
        />
      </div>

      <DateRangeField id="quote-window" label="Delivery window" value={dates} onChange={setDates} minDate={minDate} today={today} />

      <div className="field">
        <label className="field-label" htmlFor="quote-message">
          Message
        </label>
        <textarea
          id="quote-message"
          className="textarea"
          rows={3}
          placeholder="Roast profile, delivery instructions, anything the roaster should know…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {error ? (
        <div className="alert alert-error" role="alert">
          <Icon name="alert" size={18} />
          <div>{error.message}</div>
        </div>
      ) : null}
    </Modal>
  );
}
