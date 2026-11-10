import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './lib/api.js';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Contacts from './pages/Contacts.jsx';
import Campaigns from './pages/Campaigns.jsx';
import CampaignEditor from './pages/CampaignEditor.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Suppressions from './pages/Suppressions.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return <div className="login-shell"><p className="muted">Loading...</p></div>;
  }

  if (!user) return <Login onSignedIn={setUser} />;

  return (
    <div className="app">
      <Sidebar user={user} onSignedOut={() => setUser(null)} />
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/contacts" element={<Contacts />} />
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

function Sidebar({ user, onSignedOut }) {
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
    <aside className="sidebar">
      <h1>Mail Service</h1>
      <nav>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/contacts">Contacts</NavLink>
        <NavLink to="/campaigns">Campaigns</NavLink>
        <NavLink to="/suppressions">Suppressions</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="user">
        <strong>{user.name || user.email}</strong>
        <span className="muted">{user.role === 'admin' ? 'Administrator' : 'Sender'}</span>
        <button type="button" onClick={signOut}>Sign out</button>
      </div>
    </aside>
  );
}
