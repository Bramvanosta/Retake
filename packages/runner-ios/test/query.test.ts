/**
 * A scenario's target as the iOS driver's query (src/query.ts): text, label (label, aria, or name beside a role),
 * accessibility identifier (testid), element types per role (textbox: any text input), placeholder, nth, exact; the
 * keys the driver does not read are refused in words.
 */
import { describe, expect, it } from 'vitest';
import { ROLE_TYPES, driverQuery } from '../src/query.js';

describe('driverQuery', () => {
  it('a string is a text; the keys map to the driver query', () => {
    expect(driverQuery('Selowa Ridge')).toEqual({ text: 'Selowa Ridge' });
    expect(driverQuery({ testid: 'add-to-quote' })).toEqual({ id: 'add-to-quote' });
    expect(driverQuery({ label: 'Email' })).toEqual({ label: 'Email' });
    expect(driverQuery({ aria: 'Close' })).toEqual({ label: 'Close' });
    expect(driverQuery({ placeholder: 'Search coffees', exact: true })).toEqual({ placeholder: 'Search coffees', exact: true });
    expect(driverQuery({ text: 'Lot', nth: 1 })).toEqual({ text: 'Lot', nth: 1 });
  });

  it('a role is its element types, its name the label; textbox is any text input', () => {
    expect(driverQuery({ role: 'button', name: 'Increment' })).toEqual({ roles: ['button'], label: 'Increment' });
    expect(driverQuery({ role: 'textbox' })).toEqual({ roles: ['textField', 'secureTextField', 'searchField', 'textView'] });
    expect(driverQuery({ role: 'Checkbox' }).roles).toEqual(['switch']);
    expect(driverQuery({ role: 'heading', name: 'Request sent' })).toEqual({ roles: ['staticText'], label: 'Request sent' });
    expect(driverQuery({ role: 'row', name: 'Selowa' }).roles).toEqual(['cell']);
    expect(Object.keys(ROLE_TYPES)).toEqual(['button', 'textbox', 'checkbox', 'switch', 'heading', 'text', 'cell', 'row']);
  });

  it('what the driver cannot read is refused in words', () => {
    expect(() => driverQuery({ css: '#send' })).toThrow(/`css` is not available on iOS/);
    expect(() => driverQuery({ text: 'Delete', in: 'dialog' })).toThrow(/`in` is not available on iOS/);
    expect(() => driverQuery({ role: 'listbox' })).toThrow(/role "listbox" is not available on iOS/);
    expect(() => driverQuery({ text: 'Lot', nth: -1 })).toThrow(/nth counts from 0/);
    expect(() => driverQuery({ exact: true })).toThrow(/names nothing/);
  });
});
