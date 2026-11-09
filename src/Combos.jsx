import { useEffect, useRef } from 'react';
import { mountWorkbench } from './astra/workbench.mjs';
import styles from './astra/workbench.css?inline';

// Isolated styles, same server and Key Vault. No iframe or credentials bridge.
export function CombosModule({ apiBase, authFetch, profile = 'default', active = true }) {
  const host = useRef(null), client = useRef(authFetch), control = useRef(null);
  client.current = authFetch;
  useEffect(() => {
    const shadow = host.current.shadowRoot || host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style'), root = document.createElement('div');
    style.textContent = styles;
    shadow.replaceChildren(style, root);
    const dispose = mountWorkbench(root, { apiBase, profile, authFetch: (...args) => client.current(...args) });
    control.current = dispose;
    return () => { control.current = null; dispose(); shadow.replaceChildren(); };
  }, [apiBase, profile]);
  useEffect(() => { control.current?.setActive(active); }, [active, apiBase, profile]);
  return <div ref={host} aria-label="Astra combo scanner and hedge optimizer" style={{ minWidth: 0, height: '100%', overflow: 'auto' }} />;
}
