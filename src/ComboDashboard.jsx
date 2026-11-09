import { useState } from 'react';
import { CombosModule } from './Combos.jsx';
import './astra/dashboard.css';

// The broad sports terminal is mounted only when explicitly opened.
export function ComboDashboard({ profile, connected, onLock, apiBase, authFetch, connection, positions, otherTools, toast }) {
  const [view, setView] = useState('combos');
  return <div className="combo-dashboard">
    <header className="workspace-header">
      <div className="workspace-brand">KALSHI <span>ASTRA</span></div>
      <nav aria-label="Workspace">
        {[['combos', 'Combos'], ['positions', 'Live positions'], ['connection', 'Connection']].map(([id, label]) =>
          <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}</button>)}
      </nav>
      <div className="workspace-account">
        <span className="connection-state">{connected ? 'Keys saved' : 'Public data'}</span>
        <details className="workspace-menu"><summary>More</summary><div>
          <button onClick={e => { setView('tools'); e.currentTarget.closest('details').open = false; }}>Other tools</button>
          <button onClick={onLock}>Lock workspace</button>
        </div></details>
      </div>
    </header>
    <div className="workspace-body">
      <section className="workspace-view" hidden={view !== 'combos'} aria-label="Combo workspace">
        <CombosModule profile={profile} apiBase={apiBase} authFetch={authFetch} active={view === 'combos'} />
      </section>
      {view === 'connection' && <section className="workspace-view" aria-label="Connection settings">{connection()}</section>}
      {view === 'positions' && <section className="workspace-view" aria-label="Live account positions">{positions()}</section>}
      {view === 'tools' && <section className="workspace-view" aria-label="Other tools">
        <div className="tools-return"><button onClick={() => setView('combos')}>Back to combos</button><span>Sports terminal · live trading controls</span></div>
        {otherTools()}
      </section>}
    </div>
    {toast && <div role="status" className={`workspace-toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.msg}</div>}
  </div>;
}
