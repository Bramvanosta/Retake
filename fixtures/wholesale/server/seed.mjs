// Deterministic seed data of the fictional "Northfield" coffee-wholesale platform.
// Every name here (organisations, people, cafés, competitions, registry) is fictional.
// buildSeed() returns a fresh deep copy each time so POST /api/reset restores this exact state.

/** The demo calendar day. All seeded dates are relative to it and the demo clock starts on it. */
export const DEMO_DATE = '2026-11-02';
/** Time of day at which the demo clock starts after every reset (local wall time of the fixture). */
export const DEMO_START_TIME = '10:24:00';

export const VAT_RATE = 0.25;
export const SHIPPING_EUR = 30;
export const BAG_SIZES = ['250 g', '1 kg', '5 kg', '20 kg'];
export const BAG_KG = { '250 g': 0.25, '1 kg': 1, '5 kg': 5, '20 kg': 20 };
export const GRIND_OPTIONS = ['Whole bean', 'Espresso', 'Filter', 'Cold brew'];
export const LABEL_LANGUAGES = [
  'Swedish',
  'Norwegian',
  'Danish',
  'Finnish',
  'Icelandic',
  'English',
  'French',
  'German',
  'Dutch',
  'Estonian',
  'Latvian',
  'Lithuanian',
  'Polish',
  'Spanish',
  'Italian',
];

export const SUPPLIER_USER = { name: 'Maja Lindqvist', role: 'Supply manager', initials: 'ML' };

export const BUYER = {
  id: 'demo-cafe',
  name: 'Demo Café',
  initials: 'DC',
  contact: 'Elin Berg',
  email: 'orders@demo-cafe.example',
  address: ['Kaffegatan 4', '118 20 Stockholm', 'Sweden'],
  city: 'Stockholm',
  country: 'Sweden',
  country_code: 'SE',
  vat_number: 'SE 5590 1234 5601',
};

export const ORGANIZATIONS = [
  { id: 'northfield-roasters', name: 'Northfield Roasters', city: 'Gothenburg', country: 'Sweden', initials: 'NR', tone: 'burgundy' },
  { id: 'kettle-crate', name: 'Kettle & Crate', city: 'Aarhus', country: 'Denmark', initials: 'KC', tone: 'green' },
  { id: 'old-harbour', name: 'Old Harbour Coffee', city: 'Bergen', country: 'Norway', initials: 'OH', tone: 'blue' },
  { id: 'birch-ember', name: 'Birch & Ember Roastery', city: 'Tampere', country: 'Finland', initials: 'BE', tone: 'amber' },
];

/** Regions (markets) a supplier can sell in. `languages` are the usual label languages there. */
export const REGIONS = [
  { code: 'IS', name: 'Iceland', languages: ['Icelandic', 'English'] },
  { code: 'SE', name: 'Sweden', languages: ['Swedish'] },
  { code: 'NO', name: 'Norway', languages: ['Norwegian'] },
  { code: 'DK', name: 'Denmark', languages: ['Danish'] },
  { code: 'FI', name: 'Finland', languages: ['Finnish', 'Swedish'] },
  { code: 'EE', name: 'Estonia', languages: ['Estonian', 'English'] },
  { code: 'LV', name: 'Latvia', languages: ['Latvian', 'English'] },
  { code: 'LT', name: 'Lithuania', languages: ['Lithuanian', 'English'] },
  { code: 'DE', name: 'Germany', languages: ['German'] },
  { code: 'FR', name: 'France', languages: ['French'] },
  { code: 'NL', name: 'Netherlands', languages: ['Dutch'] },
  { code: 'BE', name: 'Belgium', languages: ['Dutch', 'French'] },
  { code: 'AT', name: 'Austria', languages: ['German'] },
  { code: 'CH', name: 'Switzerland', languages: ['German', 'French'] },
  { code: 'PL', name: 'Poland', languages: ['Polish', 'English'] },
  { code: 'IE', name: 'Ireland', languages: ['English'] },
];

/** Offers created by an import, per organisation, split by region (sums are exact). */
export const IMPORT_RESULTS = {
  'northfield-roasters': [
    ['Sweden', 142], ['Germany', 128], ['Norway', 118], ['Denmark', 104], ['Finland', 96], ['France', 87], ['Netherlands', 76],
    ['Iceland', 41], ['Estonia', 34], ['Latvia', 29], ['Lithuania', 27], ['Belgium', 18], ['Austria', 12], ['Poland', 9],
  ],
  'kettle-crate': [['Denmark', 96], ['Sweden', 74], ['Germany', 58], ['Norway', 41], ['Netherlands', 27], ['Finland', 16]],
  'old-harbour': [['Norway', 64], ['Sweden', 38], ['Denmark', 31], ['Iceland', 25]],
  'birch-ember': [['Finland', 88], ['Estonia', 41], ['Sweden', 37], ['Latvia', 19], ['Lithuania', 17]],
};

// ── Coffee lots, as published by the (fictional) Open Lot Registry ───────────

function lot(ref, name, o) {
  return {
    ref,
    name,
    farm: o.farm ?? name.split(' — ')[0],
    producer: o.producer,
    origin: o.origin,
    region: o.region,
    variety: o.variety,
    process: o.process,
    altitude: o.altitude,
    harvest_year: o.year,
    score: o.score,
    notes: o.notes,
    profile: o.profile,
    awards: o.awards ?? [],
    story: o.story,
    farm_facts: o.facts,
    palette: o.palette,
  };
}

const LOTS = [
  lot('GCR-26-0107', 'Finca El Paraíso — Geisha', {
    producer: 'Lucía & Tomás Arango',
    origin: 'Colombia',
    region: 'Cauca',
    variety: 'Geisha',
    process: 'Anaerobic washed',
    altitude: '1,930 m',
    year: 2026,
    score: 92.5,
    notes: ['Jasmine', 'Bergamot', 'White peach', 'Wildflower honey'],
    profile: { acidity: 4.6, sweetness: 4.7, body: 3.2, finish: 4.5 },
    awards: [
      { title: 'Cup of Origin · Colombia 2025', detail: '1st place · Lot #1', score: '93.1 points', kind: 'gold' },
      { title: 'Registry cupping 2026', detail: 'Specialty grade, 3 cuppers', score: '92.5 points', kind: 'score' },
      { title: 'Producers’ Reserve Auction 2025', detail: 'Highest bid of the auction', score: '€212 / kg', kind: 'silver' },
    ],
    story:
      'Lucía and Tomás took over the family farm in 2009 and replanted the upper slopes with Geisha. Cherries ferment for 48 hours in sealed tanks before a cold wash, which keeps the florals bright and the cup remarkably clean.',
    facts: { size: '18 ha', harvest: 'May – July', drying: 'Raised beds, 21 days', shade: 'Guamo & banana' },
    palette: 'apricot',
  }),
  lot('GCR-26-0233', 'Kiamabara AA', {
    farm: 'Kiamabara washing station',
    producer: '920 smallholder members',
    origin: 'Kenya',
    region: 'Nyeri',
    variety: 'SL28 · SL34',
    process: 'Washed, double fermentation',
    altitude: '1,750 m',
    year: 2026,
    score: 89.0,
    notes: ['Blackcurrant', 'Pink grapefruit', 'Cane sugar'],
    profile: { acidity: 4.8, sweetness: 4.1, body: 3.6, finish: 4.0 },
    awards: [{ title: 'Registry cupping 2026', detail: 'AA screen 17/18', score: '89.0 points', kind: 'score' }],
    story:
      'Members deliver ripe cherry to the station every afternoon of the main crop. After pulping, the parchment is fermented twice, soaked overnight in clean river water and dried slowly on raised tables.',
    facts: { size: '920 smallholdings', harvest: 'Oct – Dec', drying: 'Raised tables, 14 days', shade: 'Grevillea' },
    palette: 'berry',
  }),
  lot('GCR-26-0318', 'Halo Beriti', {
    farm: 'Halo Beriti washing station',
    producer: 'Outgrowers of the Halo Beriti kebele',
    origin: 'Ethiopia',
    region: 'Gedeo, Yirgacheffe',
    variety: 'Heirloom 74110 · 74112',
    process: 'Washed',
    altitude: '2,150 m',
    year: 2026,
    score: 90.0,
    notes: ['Bergamot', 'Lemon blossom', 'Honey', 'Black tea'],
    profile: { acidity: 4.5, sweetness: 4.4, body: 3.0, finish: 4.3 },
    awards: [
      { title: 'Cup of Origin · Ethiopia 2026', detail: 'Top 10 finalist', score: '90.4 points', kind: 'silver' },
      { title: 'Registry cupping 2026', detail: 'Grade 1', score: '90.0 points', kind: 'score' },
    ],
    story:
      'Around 650 outgrowers bring cherry from garden plots high above the town. The station washes in small daily batches, so each lot reflects a single week of the harvest.',
    facts: { size: '650 garden plots', harvest: 'Nov – Jan', drying: 'Raised beds, 12 days', shade: 'Native forest' },
    palette: 'lemon',
  }),
  lot('GCR-26-0412', 'Finca La Esperanza', {
    producer: 'Andrés & Camila Molina',
    origin: 'Colombia',
    region: 'Huila',
    variety: 'Pink Bourbon',
    process: 'Washed, 72 h dry fermentation',
    altitude: '1,780 m',
    year: 2026,
    score: 92.0,
    notes: ['Red apple', 'Hibiscus', 'Panela', 'Cacao nib'],
    profile: { acidity: 4.4, sweetness: 4.6, body: 3.8, finish: 4.4 },
    awards: [
      { title: 'Cup of Origin · Colombia 2026', detail: '1st place · Lot #1', score: '92.0 points', kind: 'gold' },
      { title: 'Huila Regional Showcase 2026', detail: 'Best Pink Bourbon', score: '90.6 points', kind: 'silver' },
      { title: 'Registry cupping 2026', detail: 'Specialty grade, 3 cuppers', score: '92.0 points', kind: 'score' },
    ],
    story:
      'Andrés planted Pink Bourbon on the farm’s eastern slope in 2016, after years of growing Caturra for the local cooperative. A long dry fermentation and slow shade drying give this lot its deep sweetness.',
    facts: { size: '9 ha', harvest: 'Apr – Jun', drying: 'Shaded parabolic dryers, 25 days', shade: 'Inga & citrus' },
    palette: 'rose',
  }),
  lot('GCR-26-0151', 'Fazenda Boa Vista — Yellow Bourbon', {
    producer: 'Helena Duarte',
    origin: 'Brazil',
    region: 'Sul de Minas',
    variety: 'Yellow Bourbon',
    process: 'Natural',
    altitude: '1,250 m',
    year: 2026,
    score: 86.5,
    notes: ['Milk chocolate', 'Hazelnut', 'Dried apricot'],
    profile: { acidity: 3.2, sweetness: 4.3, body: 4.4, finish: 3.9 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Fine cup', score: '86.5 points', kind: 'score' }],
    story:
      'A third-generation estate where cherries dry on suspended beds for three weeks. The result is a round, chocolate-forward coffee that holds up beautifully in milk.',
    facts: { size: '64 ha', harvest: 'Jun – Aug', drying: 'Suspended beds, 20 days', shade: 'Partial, macadamia rows' },
    palette: 'caramel',
  }),
  lot('GCR-26-0274', 'La Laguna — Caturra', {
    producer: 'Esteban & Rosa Recinos',
    origin: 'Guatemala',
    region: 'Huehuetenango',
    variety: 'Caturra · Bourbon',
    process: 'Washed',
    altitude: '1,820 m',
    year: 2026,
    score: 87.5,
    notes: ['Red grape', 'Brown sugar', 'Orange zest'],
    profile: { acidity: 4.0, sweetness: 4.2, body: 3.7, finish: 3.9 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Strictly hard bean', score: '87.5 points', kind: 'score' }],
    story: 'High in the Cuchumatanes, dry winds from the Mexican plateau protect the farm from frost and let the cherries ripen slowly.',
    facts: { size: '12 ha', harvest: 'Jan – Apr', drying: 'Patio, 10 days', shade: 'Gravilea & avocado' },
    palette: 'plum',
  }),
  lot('GCR-26-0301', 'Bombe — Natural', {
    farm: 'Bombe village',
    producer: 'Smallholders of Bombe',
    origin: 'Ethiopia',
    region: 'Sidama',
    variety: 'Heirloom',
    process: 'Natural',
    altitude: '2,250 m',
    year: 2026,
    score: 89.5,
    notes: ['Strawberry', 'Blueberry', 'Dark chocolate', 'Rose'],
    profile: { acidity: 4.2, sweetness: 4.8, body: 3.9, finish: 4.2 },
    awards: [{ title: 'Sidama Selection 2026', detail: 'Top 10 natural', score: '89.5 points', kind: 'silver' }],
    story: 'Whole cherries are turned by hand every hour on African beds for close to a month, building a jammy, berry-laden sweetness.',
    facts: { size: '310 smallholdings', harvest: 'Nov – Jan', drying: 'African beds, 26 days', shade: 'Enset & native trees' },
    palette: 'violet',
  }),
  lot('GCR-26-0189', 'Finca Santa Lucía — Gesha Natural', {
    producer: 'Mariela Castillo',
    origin: 'Panama',
    region: 'Boquete, Chiriquí',
    variety: 'Gesha',
    process: 'Natural',
    altitude: '1,700 m',
    year: 2026,
    score: 91.0,
    notes: ['Mango', 'Jasmine', 'Passion fruit'],
    profile: { acidity: 4.5, sweetness: 4.7, body: 3.4, finish: 4.6 },
    awards: [{ title: 'Best of Panama Selection 2026', detail: 'Natural category, 3rd place', score: '91.0 points', kind: 'silver' }],
    story: 'Misty afternoons and the bajareque rain slow down ripening on this small Gesha plot, giving dense, perfumed beans.',
    facts: { size: '6 ha', harvest: 'Feb – Apr', drying: 'Raised beds in greenhouses, 30 days', shade: 'Cloud forest' },
    palette: 'mango',
  }),
  lot('GCR-26-0355', 'Nyamasheke Lot 7', {
    farm: 'Nyamasheke washing station',
    producer: 'Lake Kivu growers’ group',
    origin: 'Rwanda',
    region: 'Western Province',
    variety: 'Red Bourbon',
    process: 'Washed',
    altitude: '1,900 m',
    year: 2026,
    score: 88.0,
    notes: ['Red currant', 'Black tea', 'Molasses'],
    profile: { acidity: 4.3, sweetness: 4.0, body: 3.5, finish: 3.9 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Lot 7 of 12', score: '88.0 points', kind: 'score' }],
    story: 'Growers on the hills above Lake Kivu deliver to the station by bicycle; every lot is floated, hand-sorted and dried under shade nets.',
    facts: { size: '1,400 smallholdings', harvest: 'Mar – Jun', drying: 'Raised beds, 18 days', shade: 'Banana' },
    palette: 'cherry',
  }),
  lot('GCR-26-0262', 'Hacienda Santa Rosa — Pacamara', {
    producer: 'The Aguilar family',
    origin: 'El Salvador',
    region: 'Chalatenango',
    variety: 'Pacamara',
    process: 'Red honey',
    altitude: '1,650 m',
    year: 2026,
    score: 88.5,
    notes: ['Plum', 'Cocoa', 'Caramel'],
    profile: { acidity: 3.9, sweetness: 4.5, body: 4.1, finish: 4.0 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Large screen 18+', score: '88.5 points', kind: 'score' }],
    story: 'Large Pacamara beans are pulped and dried with most of their mucilage, a red honey process that adds body and a syrupy finish.',
    facts: { size: '22 ha', harvest: 'Dec – Feb', drying: 'Patio & raised beds, 15 days', shade: 'Pepeto & citrus' },
    palette: 'cocoa',
  }),
  lot('GCR-26-0246', 'Kirinyaga Peaberry', {
    farm: 'Kirinyaga cooperative stations',
    producer: 'Smallholders of Kirinyaga county',
    origin: 'Kenya',
    region: 'Kirinyaga',
    variety: 'SL28 · Ruiru 11',
    process: 'Washed',
    altitude: '1,700 m',
    year: 2026,
    score: 87.5,
    notes: ['Hibiscus', 'Red plum', 'Lime'],
    profile: { acidity: 4.6, sweetness: 3.9, body: 3.4, finish: 3.8 },
    awards: [{ title: 'Registry cupping 2026', detail: 'PB grade', score: '87.5 points', kind: 'score' }],
    story: 'Peaberries are separated by hand on the drying tables; their round shape roasts evenly and brings a lively, juicy cup.',
    facts: { size: '2,100 smallholdings', harvest: 'Oct – Dec', drying: 'Raised tables, 15 days', shade: 'Macadamia' },
    palette: 'berry',
  }),
  lot('GCR-26-0128', 'Cerrado Lot 21', {
    farm: 'Fazenda Três Pontes',
    producer: 'Rafael Nogueira',
    origin: 'Brazil',
    region: 'Cerrado Mineiro',
    variety: 'Red Catuaí',
    process: 'Pulped natural',
    altitude: '1,100 m',
    year: 2026,
    score: 85.5,
    notes: ['Cocoa', 'Roasted almond', 'Orange'],
    profile: { acidity: 3.0, sweetness: 4.1, body: 4.5, finish: 3.7 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Espresso selection', score: '85.5 points', kind: 'score' }],
    story: 'A dependable, low-acidity espresso base from the high plateau, harvested selectively and dried in mechanical dryers at low temperature.',
    facts: { size: '140 ha', harvest: 'May – Aug', drying: 'Patio then low-heat dryers', shade: 'Full sun' },
    palette: 'caramel',
  }),
  lot('GCR-26-0390', 'Kayanza Hills — Natural', {
    farm: 'Kayanza Hills station',
    producer: 'Kayanza growers’ association',
    origin: 'Burundi',
    region: 'Kayanza',
    variety: 'Red Bourbon',
    process: 'Natural',
    altitude: '1,850 m',
    year: 2026,
    score: 88.0,
    notes: ['Raspberry', 'Cola', 'Tamarind'],
    profile: { acidity: 4.1, sweetness: 4.4, body: 3.8, finish: 3.9 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Natural selection', score: '88.0 points', kind: 'score' }],
    story: 'Hand-picked cherries are floated and sorted twice before drying whole on raised beds for up to four weeks.',
    facts: { size: '1,050 smallholdings', harvest: 'Mar – Jun', drying: 'Raised beds, 28 days', shade: 'Banana & eucalyptus' },
    palette: 'cherry',
  }),
  lot('GCR-26-0433', 'Aceh Gayo — Wet hulled', {
    farm: 'Gayo highland cooperatives',
    producer: 'Gayo highland growers',
    origin: 'Indonesia',
    region: 'Aceh',
    variety: 'Ateng · Tim Tim',
    process: 'Wet hulled',
    altitude: '1,500 m',
    year: 2026,
    score: 85.0,
    notes: ['Cedar', 'Dark cocoa', 'Black pepper'],
    profile: { acidity: 2.8, sweetness: 3.8, body: 4.7, finish: 3.9 },
    awards: [{ title: 'Registry cupping 2026', detail: 'Grade 1', score: '85.0 points', kind: 'score' }],
    story: 'Parchment is hulled while still moist, the traditional giling basah process that gives Sumatran coffees their heavy body.',
    facts: { size: '3,000 smallholdings', harvest: 'Oct – Jun', drying: 'Patio, 3–5 days after hulling', shade: 'Lamtoro' },
    palette: 'forest',
  }),
  // Registry-only lots (not in the catalogue): found by "Add a coffee".
  lot('GCR-25-0388', 'Finca La Esperanza', {
    producer: 'Andrés & Camila Molina',
    origin: 'Colombia',
    region: 'Huila',
    variety: 'Pink Bourbon',
    process: 'Washed',
    altitude: '1,780 m',
    year: 2025,
    score: 87.75,
    notes: ['Red apple', 'Panela', 'Cacao nib'],
    profile: { acidity: 4.2, sweetness: 4.3, body: 3.7, finish: 4.0 },
    story: 'Previous harvest of the Molina family farm.',
    facts: { size: '9 ha', harvest: 'Apr – Jun', drying: 'Shaded parabolic dryers', shade: 'Inga & citrus' },
    palette: 'rose',
  }),
  lot('GCR-24-0291', 'Finca La Esperanza', {
    producer: 'Andrés & Camila Molina',
    origin: 'Colombia',
    region: 'Huila',
    variety: 'Caturra',
    process: 'Washed',
    altitude: '1,780 m',
    year: 2024,
    score: 86.5,
    notes: ['Green apple', 'Caramel'],
    profile: { acidity: 4.0, sweetness: 4.0, body: 3.6, finish: 3.7 },
    story: 'Last Caturra harvest before the farm moved to Pink Bourbon.',
    facts: { size: '9 ha', harvest: 'Apr – Jun', drying: 'Patio', shade: 'Inga' },
    palette: 'rose',
  }),
  lot('GCR-25-1170', 'Cooperativa La Esperanza', {
    producer: '86 member families',
    origin: 'Peru',
    region: 'Cajamarca',
    variety: 'Caturra · Typica',
    process: 'Washed',
    altitude: '1,850 m',
    year: 2025,
    score: 86.0,
    notes: ['Caramel', 'Mandarin', 'Almond'],
    profile: { acidity: 3.8, sweetness: 4.1, body: 3.6, finish: 3.7 },
    story: 'A cooperative lot blended from member farms around Jaén.',
    facts: { size: '86 farms', harvest: 'May – Aug', drying: 'Solar dryers', shade: 'Native trees' },
    palette: 'caramel',
  }),
  lot('GCR-26-0450', 'Finca El Mirador — Sudan Rume', {
    producer: 'Julián Paredes',
    origin: 'Colombia',
    region: 'Nariño',
    variety: 'Sudan Rume',
    process: 'Washed',
    altitude: '2,050 m',
    year: 2026,
    score: 90.25,
    notes: ['Lychee', 'Rose', 'Cane sugar'],
    profile: { acidity: 4.4, sweetness: 4.5, body: 3.3, finish: 4.3 },
    story: 'A rare Sudan Rume plot on a ridge above the Juanambú canyon.',
    facts: { size: '4 ha', harvest: 'May – Jul', drying: 'Raised beds', shade: 'Native forest' },
    palette: 'rose',
  }),
  lot('GCR-26-0471', 'Finca Las Nubes — Geisha', {
    producer: 'Sofía Benítez',
    origin: 'Ecuador',
    region: 'Pichincha',
    variety: 'Geisha',
    process: 'Washed',
    altitude: '1,600 m',
    year: 2026,
    score: 91.5,
    notes: ['Jasmine', 'Peach', 'Lemongrass'],
    profile: { acidity: 4.5, sweetness: 4.6, body: 3.1, finish: 4.5 },
    story: 'A cloud-forest farm on the western slope of the Andes.',
    facts: { size: '7 ha', harvest: 'Jun – Sep', drying: 'Raised beds', shade: 'Cloud forest' },
    palette: 'apricot',
  }),
  lot('GCR-26-0502', 'Guji Uraga — Natural', {
    producer: 'Uraga smallholders',
    origin: 'Ethiopia',
    region: 'Guji',
    variety: 'Heirloom',
    process: 'Natural',
    altitude: '2,200 m',
    year: 2026,
    score: 89.0,
    notes: ['Blueberry', 'Cocoa', 'Bergamot'],
    profile: { acidity: 4.2, sweetness: 4.6, body: 3.8, finish: 4.1 },
    story: 'Cherry from forest gardens dried whole on raised beds.',
    facts: { size: '540 smallholdings', harvest: 'Nov – Jan', drying: 'African beds', shade: 'Native forest' },
    palette: 'violet',
  }),
  lot('GCR-26-0519', 'Finca San Isidro — Castillo', {
    producer: 'Marta Quintero',
    origin: 'Colombia',
    region: 'Tolima',
    variety: 'Castillo',
    process: 'Honey',
    altitude: '1,700 m',
    year: 2026,
    score: 86.75,
    notes: ['Toffee', 'Red cherry', 'Orange'],
    profile: { acidity: 3.8, sweetness: 4.3, body: 3.9, finish: 3.8 },
    story: 'A family farm in southern Tolima experimenting with honey processing.',
    facts: { size: '11 ha', harvest: 'Oct – Dec', drying: 'Raised beds', shade: 'Guamo' },
    palette: 'cherry',
  }),
];

// ── Catalogue (supplier products built from registry lots) ───────────────────

/** Price per kg for 5 kg bags; the other sizes are derived (see pricesFor). */
const CATALOGUE = [
  { ref: 'GCR-26-0107', slug: 'finca-el-paraiso-geisha', price5: 79.5, lot: 'NF-26-014', badge: 'Cup of Origin · Lot #1', shelves: ['awards'], added: '2026-09-18' },
  { ref: 'GCR-26-0233', slug: 'kiamabara-aa', price5: 34.2, lot: 'NF-26-031', badge: 'New harvest', shelves: ['arrivals'], added: '2026-10-22' },
  { ref: 'GCR-26-0318', slug: 'halo-beriti', price5: 36.4, lot: 'NF-26-029', badge: 'Top 10 · Ethiopia 2026', shelves: ['arrivals'], added: '2026-10-20' },
  { ref: 'GCR-26-0189', slug: 'finca-santa-lucia-gesha-natural', price5: 72.0, lot: 'NF-26-008', badge: 'Best of Panama · 91 pts', shelves: ['awards'], added: '2026-08-30' },
  { ref: 'GCR-26-0301', slug: 'bombe-natural', price5: 33.8, lot: 'NF-26-027', badge: 'Sidama Selection · Top 10', shelves: ['awards'], added: '2026-10-15' },
  { ref: 'GCR-26-0151', slug: 'fazenda-boa-vista-yellow-bourbon', price5: 24.6, lot: 'NF-26-011', badge: 'Espresso favourite', shelves: ['espresso'], added: '2026-07-12' },
  { ref: 'GCR-26-0274', slug: 'la-laguna-caturra', price5: 27.9, lot: 'NF-26-019', badge: null, shelves: ['espresso'], added: '2026-08-04' },
  { ref: 'GCR-26-0355', slug: 'nyamasheke-lot-7', price5: 29.4, lot: 'NF-26-024', badge: 'New harvest', shelves: ['arrivals'], added: '2026-10-08' },
  { ref: 'GCR-26-0262', slug: 'hacienda-santa-rosa-pacamara', price5: 31.5, lot: 'NF-26-016', badge: null, shelves: ['espresso'], added: '2026-08-21' },
  { ref: 'GCR-26-0246', slug: 'kirinyaga-peaberry', price5: 30.6, lot: 'NF-26-033', badge: 'New harvest', shelves: ['arrivals'], added: '2026-10-27' },
  { ref: 'GCR-26-0128', slug: 'cerrado-lot-21', price5: 21.9, lot: 'NF-26-005', badge: 'House espresso', shelves: ['espresso'], added: '2026-06-02' },
  { ref: 'GCR-26-0390', slug: 'kayanza-hills-natural', price5: 30.2, lot: 'NF-26-022', badge: 'Producer reserve', shelves: ['awards'], added: '2026-09-02' },
  { ref: 'GCR-26-0433', slug: 'aceh-gayo-wet-hulled', price5: 26.4, lot: 'NF-26-013', badge: null, shelves: [], added: '2026-07-28' },
  // Archived: still holds its registry ref, so adding the 2026 harvest again is refused as a duplicate.
  { ref: 'GCR-26-0412', slug: 'finca-la-esperanza', price5: 41.0, lot: 'NF-26-002', badge: null, shelves: [], added: '2026-05-14', status: 'archived' },
];

const round10 = (n) => Math.round(n * 10) / 10;

export function pricesFor(price5) {
  return { '250 g': round10(price5 * 1.28), '1 kg': round10(price5 * 1.07), '5 kg': price5, '20 kg': round10(price5 * 0.93) };
}

// ── Availability by region ───────────────────────────────────────────────────

function row(code, window, bags, grinds, labels, status = 'active', extra = {}) {
  const region = REGIONS.find((r) => r.code === code);
  return {
    id: code.toLowerCase(),
    region: region.name,
    code,
    window_start: window[0],
    window_end: window[1],
    bag_sizes: bags,
    grind_options: grinds,
    label_languages: labels,
    status,
    min_order_bags: extra.min ?? 1,
    reserved_pct: extra.reserved ?? 0,
  };
}

/** Sweden on generated products: open now, so buyers can request any date from the lead time on. */
const W0 = ['2026-11-23', '2027-03-31'];
const W1 = ['2027-01-12', '2027-04-30'];
const W2 = ['2027-01-19', '2027-05-14'];
const W3 = ['2027-02-01', '2027-05-31'];

/** The hero product of the availability screen: every region, long enough to scroll. */
const PARAISO_AVAILABILITY = [
  row('IS', W1, ['250 g', '1 kg'], ['Whole bean'], ['Icelandic', 'English'], 'active', { reserved: 42 }),
  row('SE', W1, ['250 g', '5 kg'], ['Whole bean', 'Filter'], ['English'], 'active', { reserved: 61 }),
  row('NO', W1, ['250 g', '1 kg', '5 kg'], ['Whole bean', 'Espresso'], ['Norwegian'], 'active', { reserved: 37 }),
  row('DK', W1, ['1 kg', '5 kg'], ['Whole bean', 'Espresso', 'Filter'], ['Danish', 'English'], 'active', { reserved: 55 }),
  row('FI', W2, ['250 g', '1 kg'], ['Whole bean', 'Filter'], ['Finnish', 'Swedish'], 'active', { reserved: 28 }),
  row('EE', W2, ['1 kg'], ['Whole bean'], ['Estonian', 'English'], 'scheduled', { reserved: 0 }),
  row('LV', W2, ['1 kg'], ['Whole bean'], ['Latvian', 'English'], 'paused', { reserved: 12 }),
  row('LT', W2, ['1 kg'], ['Whole bean'], ['Lithuanian', 'English'], 'scheduled', { reserved: 0 }),
  row('DE', W1, ['250 g', '1 kg', '5 kg', '20 kg'], ['Whole bean', 'Espresso', 'Filter'], ['German'], 'active', { reserved: 48, min: 2 }),
  row('FR', W1, ['250 g', '1 kg', '5 kg'], ['Whole bean', 'Espresso'], ['French'], 'active', { reserved: 33 }),
  row('NL', W1, ['1 kg', '5 kg'], ['Whole bean', 'Filter'], ['Dutch', 'English'], 'active', { reserved: 40 }),
  row('BE', W3, ['1 kg', '5 kg'], ['Whole bean'], ['Dutch', 'French'], 'scheduled', { reserved: 0 }),
  row('AT', W3, ['250 g', '1 kg'], ['Whole bean', 'Espresso'], ['German'], 'active', { reserved: 19 }),
  row('CH', W3, ['250 g', '1 kg'], ['Whole bean', 'Espresso'], ['German', 'French'], 'active', { reserved: 22 }),
  row('PL', W3, ['1 kg', '5 kg'], ['Whole bean'], ['Polish', 'English'], 'scheduled', { reserved: 0 }),
  row('IE', W2, ['250 g', '1 kg'], ['Whole bean', 'Filter'], ['English'], 'active', { reserved: 26 }),
];

const ROTATION = [
  ['SE', 'NO', 'DK', 'FI', 'DE', 'NL', 'FR', 'IS'],
  ['SE', 'DK', 'DE', 'NL', 'BE', 'AT'],
  ['SE', 'NO', 'FI', 'EE', 'LV', 'LT', 'PL'],
  ['SE', 'NO', 'DK', 'DE', 'FR', 'CH', 'IE'],
];

function generatedAvailability(index, slug) {
  const codes = ROTATION[index % ROTATION.length];
  const windows = [W1, W2, W3];
  return codes.map((code, i) => {
    const region = REGIONS.find((r) => r.code === code);
    const bags = i % 3 === 0 ? ['1 kg', '5 kg', '20 kg'] : i % 3 === 1 ? ['250 g', '1 kg', '5 kg'] : ['1 kg', '5 kg'];
    const grinds = i % 2 === 0 ? ['Whole bean', 'Espresso', 'Filter'] : ['Whole bean', 'Filter'];
    const status = code === 'SE' ? 'active' : (i + slug.length) % 7 === 3 ? 'paused' : (i + index) % 5 === 4 ? 'scheduled' : 'active';
    return row(code, code === 'SE' ? W0 : windows[(i + index) % 3], bags, grinds, [...region.languages], status, {
      reserved: status === 'active' ? 15 + ((i * 17 + index * 7) % 50) : 0,
    });
  });
}

// ── Imports ──────────────────────────────────────────────────────────────────

const IMPORTS = [
  { id: 'imp-0108', file_name: 'Northfield - Price list Q4 2026.xlsx', file_size: 1_468_211, organization_id: 'northfield-roasters', created_at: '2026-10-28T09:12:00', offers: 884, regions: 14, status: 'completed', warnings: 0, by: 'Maja Lindqvist' },
  { id: 'imp-0107', file_name: 'Kettle & Crate - Winter lots.csv', file_size: 284_530, organization_id: 'kettle-crate', created_at: '2026-10-21T15:40:00', offers: 312, regions: 6, status: 'completed', warnings: 0, by: 'Jonas Kjær' },
  { id: 'imp-0106', file_name: 'Old Harbour - Spot lots October.xlsx', file_size: 512_004, organization_id: 'old-harbour', created_at: '2026-10-14T11:05:00', offers: 158, regions: 4, status: 'completed', warnings: 3, by: 'Ingrid Solberg' },
  { id: 'imp-0105', file_name: 'Birch & Ember - Microlots.xlsx', file_size: 198_442, organization_id: 'birch-ember', created_at: '2026-10-09T08:47:00', offers: 0, regions: 0, status: 'failed', warnings: 0, error: 'Column “Harvest year” is missing', by: 'Aino Virtanen' },
  { id: 'imp-0104', file_name: 'Northfield - Price list Q3 2026.xlsx', file_size: 1_402_870, organization_id: 'northfield-roasters', created_at: '2026-07-01T10:30:00', offers: 846, regions: 13, status: 'completed', warnings: 0, by: 'Maja Lindqvist' },
  { id: 'imp-0103', file_name: 'Kettle & Crate - Summer lots.csv', file_size: 266_118, organization_id: 'kettle-crate', created_at: '2026-06-12T14:22:00', offers: 287, regions: 6, status: 'completed', warnings: 1, by: 'Jonas Kjær' },
  { id: 'imp-0102', file_name: 'Old Harbour - Spot lots June.xlsx', file_size: 455_771, organization_id: 'old-harbour', created_at: '2026-06-03T09:58:00', offers: 141, regions: 4, status: 'completed', warnings: 0, by: 'Ingrid Solberg' },
];

// ── Quotes & notifications ───────────────────────────────────────────────────

const QUOTES = [
  {
    id: '1042',
    buyer_id: 'demo-cafe',
    buyer_name: 'Demo Café',
    buyer_country: 'Sweden',
    product_slug: 'la-laguna-caturra',
    bags: 2,
    bag_size: '5 kg',
    grind: 'Whole bean',
    label_language: 'Swedish',
    window_start: '2026-11-30',
    window_end: '2026-12-11',
    message: 'Could you roast this one slightly lighter than last time?',
    created_at: '2026-11-01T16:05:00',
    status: 'requested',
    proposal: null,
  },
  {
    id: '1039',
    buyer_id: 'demo-cafe',
    buyer_name: 'Demo Café',
    buyer_country: 'Sweden',
    product_slug: 'kiamabara-aa',
    bags: 2,
    bag_size: '5 kg',
    grind: 'Whole bean',
    label_language: 'Swedish',
    window_start: '2026-10-12',
    window_end: '2026-10-23',
    message: '',
    created_at: '2026-10-05T09:31:00',
    status: 'accepted',
    proposal: { unit_price_eur: 34.2, quantity_kg: 10, shipping_eur: 30, created_at: '2026-10-05T13:02:00', valid_until: '2026-10-19', note: 'Roasted on Monday, shipped on Tuesday.' },
  },
  {
    id: '1036',
    buyer_id: 'demo-cafe',
    buyer_name: 'Demo Café',
    buyer_country: 'Sweden',
    product_slug: 'fazenda-boa-vista-yellow-bourbon',
    bags: 4,
    bag_size: '20 kg',
    grind: 'Whole bean',
    label_language: 'Swedish',
    window_start: '2026-09-14',
    window_end: '2026-09-25',
    message: 'Our house espresso — same roast profile as usual, please.',
    created_at: '2026-09-02T11:12:00',
    status: 'accepted',
    proposal: { unit_price_eur: 22.9, quantity_kg: 80, shipping_eur: 30, created_at: '2026-09-02T15:46:00', valid_until: '2026-09-16', note: '' },
  },
  {
    id: '1041',
    buyer_id: 'cafe-lindgarden',
    buyer_name: 'Café Lindgården',
    buyer_country: 'Finland',
    product_slug: 'finca-el-paraiso-geisha',
    bags: 4,
    bag_size: '1 kg',
    grind: 'Filter',
    label_language: 'Finnish',
    window_start: '2027-01-19',
    window_end: '2027-01-29',
    message: 'For our Geisha tasting week in January.',
    created_at: '2026-10-31T14:20:00',
    status: 'requested',
    proposal: null,
  },
  {
    id: '1040',
    buyer_id: 'morgon-espresso',
    buyer_name: 'Morgon Espressobar',
    buyer_country: 'Norway',
    product_slug: 'cerrado-lot-21',
    bags: 6,
    bag_size: '20 kg',
    grind: 'Espresso',
    label_language: 'Norwegian',
    window_start: '2026-11-23',
    window_end: '2026-12-04',
    message: '',
    created_at: '2026-10-29T08:55:00',
    status: 'proposal',
    proposal: { unit_price_eur: 20.4, quantity_kg: 120, shipping_eur: 30, created_at: '2026-10-29T13:10:00', valid_until: '2026-11-12', note: 'Volume price applied.' },
  },
];

const NOTIFICATIONS = [
  { id: 'n-0031', buyer_id: 'demo-cafe', kind: 'order', title: 'Order NF-2291 has shipped', body: 'Kiamabara AA · 2 × 5 kg — arriving Thursday', href: '/quotes/1039', created_at: '2026-10-13T07:45:00', read: true },
  { id: 'n-0030', buyer_id: 'demo-cafe', kind: 'arrival', title: 'New arrivals from Ethiopia', body: 'Halo Beriti and Bombe are now available in Sweden', href: '/products/halo-beriti', created_at: '2026-10-20T08:00:00', read: true },
  { id: 'n-0029', buyer_id: 'demo-cafe', kind: 'proposal', title: 'Proposal accepted', body: 'Kiamabara AA · 2 × 5 kg — €465.00 incl. VAT', href: '/quotes/1039', created_at: '2026-10-05T13:20:00', read: true },
];

// ── Assembly ─────────────────────────────────────────────────────────────────

export function registryEntries() {
  return LOTS.map((l) => structuredClone(l));
}

export function buildSeed() {
  const lots = new Map(LOTS.map((l) => [l.ref, l]));
  const products = CATALOGUE.map((c, index) => {
    const l = structuredClone(lots.get(c.ref));
    return {
      slug: c.slug,
      name: l.name,
      lot_number: c.lot,
      organization_id: 'northfield-roasters',
      farm: l.farm,
      producer: l.producer,
      origin: l.origin,
      region: l.region,
      variety: l.variety,
      process: l.process,
      altitude: l.altitude,
      harvest_year: l.harvest_year,
      score: l.score,
      notes: l.notes,
      profile: l.profile,
      awards: l.awards,
      story: l.story,
      farm_facts: l.farm_facts,
      palette: l.palette,
      prices: pricesFor(c.price5),
      badge: c.badge,
      shelves: c.shelves,
      registry_refs: [c.ref],
      status: c.status ?? 'published',
      created_at: `${c.added}T09:00:00`,
      enrichment: null,
      availability: c.slug === 'finca-el-paraiso-geisha' ? structuredClone(PARAISO_AVAILABILITY) : generatedAvailability(index, c.slug),
    };
  });
  return {
    products,
    imports: structuredClone(IMPORTS),
    quotes: structuredClone(QUOTES),
    notifications: structuredClone(NOTIFICATIONS),
    counters: { quote: 1043, import: 109, notification: 32, lot: 34 },
  };
}
