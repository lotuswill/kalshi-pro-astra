const primary = [['combos', 'Combos'], ['positions', 'Positions'], ['vault', 'Key Vault']];
const labels = { odds: 'Odds', arb: 'Arbitrage', live: 'Live markets', fresh: 'New markets', tracker: 'Tracker', journal: 'Journal', exclusive: 'Exclusive markets', favorites: 'Favorites', ppd: 'Postponement alerts', postponed: 'Postponed markets', book: 'Order book', trade: 'Trade', bot: 'Bots', mentor: 'Mentor', feedback: 'Feedback', report: 'Report a problem', settings: 'Settings' };

export function ToolNavigation({ items, active, onSelect }) {
  const extras = items.filter(item => !primary.some(([id]) => item.id === id));
  return <nav className="terminal-navigation" aria-label="Terminal tools">
    {primary.map(([id, label]) => <button key={id} aria-current={active === id ? 'page' : undefined} onClick={() => onSelect(id)}>{label}</button>)}
    <label>Other tools
      <select aria-label="Choose another tool" value={extras.some(item => item.id === active) ? active : ''} onChange={event => onSelect(event.target.value)}>
        <option value="" disabled>Choose a tool…</option>
        {extras.map(item => <option key={item.id} value={item.id}>{labels[item.id] || item.id}</option>)}
      </select>
    </label>
  </nav>;
}
