import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './lib/api.js';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Lists from './pages/Lists.jsx';
import ContactsList from './pages/ContactsList.jsx';
import Predictor from './pages/Predictor.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignEditor from './pages/CampaignEditor.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Suppressions from './pages/Suppressions.jsx';
import Settings from './pages/Settings.jsx';

const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Icon-rail mode, remembered across visits - a rep who prefers it compact
  // should not have to collapse it again on every reload.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  // Separate from `collapsed`: this is the mobile overlay drawer, which is
  // always closed on load regardless of the desktop preference.
  const [mobileOpen, setMobileOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api.me();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // The API dispatches this when a request comes back 401 - for instance
  // because an admin deactivated the account mid-session.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  }

  if (loading) {
    return <div className="login-shell"><p className="muted">Loading...</p></div>;
  }

  if (!user) return <Login onSignedIn={setUser} />;

  return (
    <div className="app">
      <Sidebar
        user={user}
        onSignedOut={() => setUser(null)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      {mobileOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <main className="main">
        <div className="mobile-topbar">
          <button
            type="button"
            className="mobile-nav-toggle"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon />
          </button>
          <strong>Mail Service</strong>
        </div>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contacts" element={<Lists />} />
          <Route path="/contacts/:id" element={<ContactsList />} />
          <Route path="/predictor" element={<Predictor />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/new" element={<CampaignEditor />} />
          <Route path="/campaigns/:id/edit" element={<CampaignEditor />} />
          <Route path="/campaigns/:id" element={<CampaignDetail user={user} />} />
          <Route path="/suppressions" element={<Suppressions />} />
          <Route path="/settings" element={<Settings user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

const NAV_ITEMS = [
  { to: '/', end: true, label: 'Dashboard', icon: DashboardIcon },
  { to: '/contacts', label: 'Contacts', icon: ContactsIcon },
  { to: '/predictor', label: 'Email Predictor', icon: PredictorIcon },
  { to: '/campaigns', label: 'Campaigns', icon: CampaignsIcon },
  { to: '/suppressions', label: 'Suppressions', icon: SuppressionsIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function Sidebar({
  user, onSignedOut, collapsed, onToggleCollapsed, mobileOpen, onCloseMobile,
}) {
  const navigate = useNavigate();

  async function signOut() {
    try {
      await api.logout();
    } finally {
      onSignedOut();
      navigate('/');
    }
  }

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}>
      <div className="sidebar-head">
        <h1 className="brand-full">Mail Service</h1>
        <button
          type="button"
          className="sidebar-toggle"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          <ChevronIcon collapsed={collapsed} />
        </button>
      </div>

      <nav onClick={onCloseMobile}>
        {NAV_ITEMS.map(({ to, end, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={end} title={label}>
            <Icon />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="user">
        <div className="user-details">
          <strong>{user.name || user.email}</strong>
          <span className="muted">{user.role === 'admin' ? 'Administrator' : 'Sender'}</span>
        </div>
        <button type="button" title="Sign out" onClick={signOut}>
          <SignOutIcon />
          <span className="sign-out-label">Sign out</span>
        </button>
      </div>
    </aside>
  );
}

/* --- Icons -------------------------------------------------------------
   Plain inline SVG rather than an icon library - six glyphs do not justify
   a new dependency, and the sidebar is the only place that needs them. */

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 17c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PredictorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 16L14 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 3.5l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9.9-1.9z" fill="currentColor" />
      <path d="M15.5 11.5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5.5-1z" fill="currentColor" />
    </svg>
  );
}

function CampaignsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M17.5 2.5L2.5 9l6 2.5 2.5 6 6.5-15z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 11.5L17.5 2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SuppressionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.1 5.1l9.8 9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M8 3H4.5a1 1 0 00-1 1v12a1 1 0 001 1H8M13 13l4-3-4-3M6.5 10h10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ collapsed }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={collapsed ? 'M7.5 5l5 5-5 5' : 'M12.5 5l-5 5 5 5'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
