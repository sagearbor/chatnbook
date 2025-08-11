// Placeholder widget app (to be served from a static host or CDN in real deployments)
export function App(){
  const root = document.createElement('div');
  root.innerHTML = '<div style="font:14px sans-serif;padding:16px">Widget placeholder. Connect API & UI here.</div>';
  document.body.appendChild(root);
}
