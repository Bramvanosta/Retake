import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect } from 'react';
import { api, useApi } from '../shared/api.js';
import { Icon, LogoMark } from '../shared/icons.jsx';
import { Link, navigate, Routes, useLocation } from '../shared/router.jsx';
import { session, urls } from '../shared/session.js';
import { Toaster } from '../shared/toast.jsx';
import { Avatar, EmptyState } from '../shared/ui.jsx';
import { AvailabilityIndexPage, AvailabilityPage } from './pages/Availability.jsx';
import { ImportsPage } from './pages/Imports.jsx';
import { ProFormaPage } from './pages/ProForma.jsx';
import { ProductPage } from './pages/Product.jsx';
import { ProductsPage } from './pages/Products.jsx';
import { QuoteRequestsPage } from './pages/QuoteRequests.jsx';

function Redirect({ to }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState icon="search" title="Page not found">
        <Link className="link" to="/products">
          Back to the catalogue
        </Link>
      </EmptyState>
    </div>
  );
}

const ROUTES = [
  ['/', () => <Redirect to="/products" />],
  ['/products', ProductsPage],
  ['/products/:slug', ProductPage],
  ['/availability', AvailabilityIndexPage],
  ['/availability/products/:slug', AvailabilityPage],
  ['/imports', ImportsPage],
  ['/quotes', QuoteRequestsPage],
  ['/proforma', ProFormaPage],
];

function NavLink({ to, icon, children, count, match }) {
  const { pathname } = useLocation();
  const active = match ? pathname.startsWith(match) : pathname === to;
  return (
    <Link to={to} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} size={18} />
      {children}
      {count ? <span className="count">{count}</span> : null}
    </Link>
  );
}

function OrgSwitcher() {
  const org = session.supplier.organization;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="org-switch" aria-label="Switch organisation">
        <Avatar initials={org.initials} tone="cream" />
        <div className="grow">
          <div className="org-name">{org.name}</div>
          <div className="org-sub">
            {org.city}, {org.country}
          </div>
        </div>
        <Icon name="chevronsUpDown" size={16} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="floating" align="start" sideOffset={8} style={{ width: 236 }}>
          <DropdownMenu.Label className="menu-label">Organisations</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item">
            <Avatar initials="NR" size="sm" />
            Northfield Roasters
            <Icon name="check" size={16} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate('/imports')}>
            <Icon name="upload" size={16} />
            Import a price list
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu() {
  const user = session.supplier.user;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="user-row" aria-label="Account menu">
        <Avatar initials={user.initials} tone="burgundy" />
        <div className="grow">
          <div className="user-name">{user.name}</div>
          <div className="user-role">{user.role}</div>
        </div>
        <Icon name="chevronsUpDown" size={16} style={{ color: '#ad9889' }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="floating" side="top" align="start" sideOffset={8} style={{ width: 236 }}>
          <DropdownMenu.Item className="menu-item">
            <Icon name="user" size={16} />
            Profile
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item">
            <Icon name="users" size={16} />
            Team
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item">
            <Icon name="settings" size={16} />
            Settings
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item">
            <Icon name="logout" size={16} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Sidebar() {
  const quotes = useApi('/api/quotes');
  const awaiting = (quotes.data ?? []).filter((q) => q.status === 'requested').length;
  return (
    <aside className="sidebar">
      <Link to="/products" className="brand" aria-label="Northfield home">
        <LogoMark size={34} dark />
        <div>
          <div className="brand-name">Northfield</div>
          <div className="brand-tag">Supplier console</div>
        </div>
      </Link>
      <OrgSwitcher />
      <nav className="nav" aria-label="Main">
        <div className="nav-section">Catalogue</div>
        <NavLink to="/products" icon="bean" match="/products">
          Coffees
        </NavLink>
        <NavLink to="/availability" icon="globe" match="/availability">
          Availability
        </NavLink>
        <NavLink to="/imports" icon="upload" match="/imports">
          Imports
        </NavLink>
        <div className="nav-section">Sales</div>
        <NavLink to="/quotes" icon="inbox" match="/quotes" count={awaiting}>
          Quote requests
        </NavLink>
        <NavLink to="/proforma" icon="file" match="/proforma">
          Pro forma invoices
        </NavLink>
        {/* A plain link, not the router's: the server-rendered reports are a full page load (R-ISS-08). */}
        <a href="/reports">
          <Icon name="receipt" size={18} />
          Sales reports
        </a>
      </nav>
      <div className="sidebar-foot">
        <a className="shop-link" href={urls.shop} target="_blank" rel="noreferrer">
          <Icon name="store" size={18} />
          <div className="grow">
            Buyer shop
            <small>See what cafés see</small>
          </div>
          <Icon name="external" size={15} />
        </a>
        <UserMenu />
      </div>
    </aside>
  );
}

/**
 * Web notifications for new quote requests (L2.9 fixture): the console asks for the permission once and polls the
 * quote list; each request that arrives while it is open shows a system notification (Notification API).
 */
function useQuoteNotifications() {
  useEffect(() => {
    if (!('Notification' in window)) return undefined;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    let known = null;
    let stopped = false;
    const tick = async () => {
      try {
        const quotes = await api.get('/api/quotes');
        const ids = new Set(quotes.map((q) => q.id));
        if (known) {
          for (const q of quotes) {
            if (known.has(q.id) || Notification.permission !== 'granted') continue;
            const what = [q.product?.name ?? q.product_slug, `${q.bags} × ${q.bag_size}`].filter(Boolean).join(' · ');
            new Notification('New quote request', {
              body: `${q.buyer_name} asks for ${what}`,
              icon: '/app-icon.svg',
              tag: 'quote-request',
            });
          }
        }
        known = ids;
      } catch {
        /* the next poll retries */
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
}

export function App() {
  useQuoteNotifications();
  return (
    <Toaster>
      <div className="console">
        <Sidebar />
        <main className="main">
          <Routes routes={ROUTES} fallback={NotFound} />
        </main>
      </div>
    </Toaster>
  );
}
