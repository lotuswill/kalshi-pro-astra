import { useEffect, useRef } from 'react';
import { mountWorkbench } from './astra/workbench.mjs';
import styles from './astra/workbench.css?inline';

// Isolated styles, same server and Key Vault. No iframe or credentials bridge.
export function CombosModule({ apiBase, authFetch, profile = 'default' }) {
  const host = useRef(null), client = useRef(authFetch);
  client.current = authFetch;
  useEffect(() => {
    const shadow = host.current.shadowRoot || host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style'), root = document.createElement('div');
    style.textContent = styles;
    shadow.replaceChildren(style, root);
    const dispose = mountWorkbench(root, { apiBase, profile, authFetch: (...args) => client.current(...args) });
    return () => { dispose(); shadow.replaceChildren(); };
  }, [apiBase, profile]);
  return <div ref={host} aria-label="Astra combo scanner and hedge optimizer" style={{ minWidth: 0, height: '100%', overflow: 'auto' }} />;
}
