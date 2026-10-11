// Delivery-window picker: a Base UI Popover (opens on click) with a two-month calendar.
// It is portaled into the enclosing Radix dialog (see useLayerContainer) and closes by itself
// shortly after the second date is chosen.

import { Popover } from '@base-ui/react/popover';
import { useState } from 'react';
import { useLayerContainer } from '../../shared/dialog.jsx';
import { dateLong, monthYear, range, weekday } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

function monthOf(isoDate) {
  const [y, m] = isoDate.split('-').map(Number);
  return { y, m: m - 1 };
}

function addMonths({ y, m }, n) {
  const t = y * 12 + m + n;
  return { y: Math.floor(t / 12), m: t % 12 };
}

function MonthGrid({ month, start, end, preview, minDate, today, onPick, onHover }) {
  const { y, m } = month;
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const rangeEnd = end ?? (start && preview && preview > start ? preview : null);
  return (
    <div>
      <div className="cal-title">{monthYear(y, m)}</div>
      <div className="cal-grid" role="grid" aria-label={monthYear(y, m)}>
        {DOW.map((d) => (
          <div key={d} className="cal-dow" aria-hidden="true">
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`b${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = iso(y, m, i + 1);
          const isStart = day === start;
          const isEnd = day === rangeEnd && day !== start;
          const inRange = start && rangeEnd && day >= start && day <= rangeEnd && start !== rangeEnd;
          return (
            <button
              key={day}
              type="button"
              className="cal-day"
              disabled={day < minDate}
              aria-label={`${weekday(day)}, ${dateLong(day)}`}
              aria-pressed={isStart || day === end}
              data-range-start={(isStart && inRange) || undefined}
              data-range-end={isEnd || undefined}
              data-in-range={inRange || undefined}
              data-today={day === today || undefined}
              data-date={day}
              onClick={() => onPick(day)}
              onMouseEnter={() => onHover(day)}
            >
              <span style={isStart && !inRange ? { background: 'var(--accent)', color: '#fff', fontWeight: 650 } : undefined}>{i + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {{ id: string, label: string, value: { start: string|null, end: string|null },
 *   onChange: (v: { start: string|null, end: string|null }) => void, minDate: string, today: string }} props
 */
export function DateRangeField({ id, label, value, onChange, minDate, today }) {
  const container = useLayerContainer();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthOf(value.start ?? minDate));
  const [hover, setHover] = useState(null);
  const minMonth = monthOf(minDate);
  const atMin = month.y * 12 + month.m <= minMonth.y * 12 + minMonth.m;

  const pick = (day) => {
    const { start, end } = value;
    if (!start || end || day < start) {
      onChange({ start: day, end: null });
      return;
    }
    onChange({ start, end: day });
    setTimeout(() => setOpen(false), 420);
  };

  const hint = !value.start ? 'Choose the first delivery day' : !value.end ? 'Now choose the last delivery day' : range(value.start, value.end);

  return (
    <div className="field">
      <div className="field-label" id={`${id}-label`}>
        {label}
      </div>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setMonth(monthOf(value.start ?? minDate));
          else setHover(null);
        }}
      >
        <Popover.Trigger id={id} className="trigger" aria-labelledby={`${id}-label`}>
          <Icon name="calendar" size={17} style={{ color: 'var(--muted)' }} />
          <span className="value">
            {value.start ? <span className="tabular">{range(value.start, value.end ?? value.start)}</span> : <span className="placeholder">Select dates</span>}
          </span>
          <Icon name="chevronDown" size={16} className="chevron" />
        </Popover.Trigger>
        <Popover.Portal container={container}>
          <Popover.Positioner className="positioner" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
            <Popover.Popup className="floating calendar" aria-label="Choose a delivery window">
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ position: 'absolute', left: -4, top: 0 }}
                  aria-label="Previous month"
                  disabled={atMin}
                  onClick={() => setMonth((mo) => addMonths(mo, -1))}
                >
                  <Icon name="chevronLeft" size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ position: 'absolute', right: -4, top: 0 }}
                  aria-label="Next month"
                  onClick={() => setMonth((mo) => addMonths(mo, 1))}
                >
                  <Icon name="chevronRight" size={18} />
                </button>
                <div className="cal-months" onMouseLeave={() => setHover(null)}>
                  {[month, addMonths(month, 1)].map((mo) => (
                    <MonthGrid
                      key={`${mo.y}-${mo.m}`}
                      month={mo}
                      start={value.start}
                      end={value.end}
                      preview={hover}
                      minDate={minDate}
                      today={today}
                      onPick={pick}
                      onHover={setHover}
                    />
                  ))}
                </div>
              </div>
              <div className="cal-foot">
                <span>{hint}</span>
                {value.start ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ start: null, end: null })}>
                    Clear dates
                  </button>
                ) : (
                  <span>Earliest delivery {dateLong(minDate)}</span>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
