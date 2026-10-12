import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import { Flag } from '../shared/art.jsx';
import { dayTime } from '../shared/format.js';
import { Icon, LogoMark } from '../shared/icons.jsx';
import { Link, navigate, Routes, useLocation } from '../shared/router.jsx';
import { session, today, urls } from '../shared/session.js';
import { Toaster } from '../shared/toast.jsx';
import { Avatar, EmptyState } from '../shared/ui.jsx';
import { markNotificationsRead, refreshNotifications, useNotifications } from './notifications.js';
import { CoffeesPage } from './pages/Coffees.jsx';
import { HomePage } from './pages/Home.jsx';
import { ProductPage } from './pages/Product.jsx';
import { QuotePage } from './pages/Quote.jsx';
import { QuotesPage } from './pages/Quotes.jsx';
import { SignupConfirmPage, SignupPage } from './pages/Signup.jsx';

const KIND_ICON = { proposal: 'receipt', order: 'truck', arrival: 'sparkles' };

/** Notifications bell: a Radix Popover (opens on click) with an unread badge. */
function Bell() {
  const { unread, items } = useNotifications();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) refreshNotifications().catch(() => {});
      }}
    >
      <Popover.Trigger className="icon-btn bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} data-unread={unread > 0 || undefined}>
        <Icon name="bell" size={19} />
        {unread ? (
          <span className="unread" aria-hidden="true">
            {unread}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="floating notif-pop" align="end" sideOffset={10} collisionPadding={16}>
          <div className="notif-head">
            <b>Notifications</b>
            {unread ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => markNotificationsRead()}>
                Mark all as read
              </button>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                All caught up
              </span>
            )}
          </div>
          <div className="notif-list">
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className="notif-item"
                data-kind={n.kind}
                data-unread={!n.read || undefined}
                onClick={() => {
                  setOpen(false);
                  if (!n.read) markNotificationsRead([n.id]).catch(() => {});
                  navigate(n.href);
                }}
              >
                <span className="notif-icon">
                  <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={17} />
                </span>
                <span className="grow">
                  <div className="notif-title">{n.title}</div>
                  <div className="notif-body">{n.body}</div>
                  <div className="notif-time">{dayTime(n.created_at, today)}</div>
                </span>
                {!n.read ? <span className="unread-dot" aria-label="Unread" /> : null}
              </button>
            ))}
            {items.length === 0 ? <EmptyState icon="bell" title="No notifications yet" /> : null}
          </div>
          <div className="notif-foot">
            <Link className="link" to="/quotes" onClick={() => setOpen(false)}>
              View all quotes
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Account menu: a Radix DropdownMenu (opens on pointerdown). */
function AccountMenu() {
  const buyer = session.buyer;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="account" aria-label="Account menu">
        <Avatar initials={buyer.initials} tone="burgundy" />
        <div>
          <div className="acc-name">{buyer.name}</div>
          <div className="acc-sub">
            <Flag code={buyer.country_code} /> {buyer.city}, {buyer.country}
          </div>
        </div>
        <Icon name="chevronDown" size={15} style={{ color: 'var(--muted)', marginLeft: 2 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="floating" align="end" sideOffset={8} style={{ width: 250 }}>
          <DropdownMenu.Label className="menu-label">{buyer.name}</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate('/quotes')}>
            <Icon name="receipt" size={16} />
            Quotes & orders
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item">
            <Icon name="truck" size={16} />
            Delivery addresses
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item">
            <Icon name="users" size={16} />
            Team members
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => window.open(urls.console, '_blank', 'noopener')}>
            <Icon name="external" size={16} />
            Supplier console
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item">
            <Icon name="logout" size={16} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function NavLink({ to, children, match }) {
  const { pathname } = useLocation();
  const active = match ? pathname.startsWith(match) : pathname === to;
  return (
    <Link to={to} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}

function Header() {
  const [q, setQ] = useState('');
  return (
    <header className="shop-header">
      <div className="shop-header-inner">
        <Link to="/" className="shop-brand" aria-label="Northfield home">
          <LogoMark size={32} />
          Northfield
        </Link>
        <nav className="shop-nav" aria-label="Main">
          <NavLink to="/">Discover</NavLink>
          <NavLink to="/coffees" match="/coffees">
            Coffees
          </NavLink>
          <NavLink to="/quotes" match="/quotes">
            Quotes
          </NavLink>
        </nav>
        <form
          className="input-icon shop-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/coffees?q=${encodeURIComponent(q)}`);
          }}
        >
          <Icon name="search" size={17} />
          <input className="input" type="search" placeholder="Search coffees, origins, producers" aria-label="Search coffees" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="header-actions">
          <Bell />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <EmptyState icon="search" title="Page not found">
      <Link className="link" to="/">
        Back to Discover
      </Link>
    </EmptyState>
  );
}

const ROUTES = [
  ['/', HomePage],
  ['/coffees', CoffeesPage],
  ['/products/:slug', ProductPage],
  ['/quotes', QuotesPage],
  ['/quotes/:id', QuotePage],
  ['/signup', SignupPage],
  ['/signup/confirm', SignupConfirmPage],
];

export function App() {
  return (
    <Toaster>
      <Header />
      <main className="shop-main">
        <Routes routes={ROUTES} fallback={NotFound} />
      </main>
      <footer className="shop-footer">
        <div className="shop-footer-inner">
          <span>© 2026 Northfield · Specialty coffee, roasted to order for cafés</span>
          <span>Prices in EUR · VAT added at checkout</span>
        </div>
      </footer>
    </Toaster>
  );
}
