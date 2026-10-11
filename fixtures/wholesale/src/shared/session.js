// Boot data injected by the server into the app shell (window.__NORTHFIELD__).

const boot = window.__NORTHFIELD__ ?? {};

export const urls = boot.urls ?? { console: 'http://localhost:4401', shop: 'http://localhost:4402' };
export const session = boot.session ?? {
  today: new Date().toISOString().slice(0, 10),
  supplier: { user: { name: 'Supplier', role: '', initials: 'S' }, organization: { name: 'Northfield Roasters' } },
  buyer: { name: 'Buyer', initials: 'B', country: 'Sweden', country_code: 'SE' },
  options: { bag_sizes: [], grind_options: [], label_languages: [] },
  vat_rate: 0.25,
};
export const today = session.today;
