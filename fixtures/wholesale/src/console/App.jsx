import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect } from 'react';
import { useApi } from '../shared/api.js';
import { Icon, LogoMark } from '../shared/icons.jsx';
import { Link, navigate, Routes, useLocation } from '../shared/router.jsx';
import { session, urls } from '../shared/session.js';
import { Toaster } from '../shared/toast.jsx';
import { Avatar, EmptyState } from '../shared/ui.jsx';
import { AvailabilityIndexPage, AvailabilityPage } from './pages/Availability.jsx';
import { ImportsPage } from './pages/Imports.jsx';
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

export function App() {
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
