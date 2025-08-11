// Async loader injecting the widget iframe with CSP-friendly styles
(function(){
  const d = document;
  function ready(fn){ if(d.readyState!='loading'){fn()} else {d.addEventListener('DOMContentLoaded',fn)} }
  ready(() => {
    const script = document.currentScript as HTMLScriptElement | null;
    const account = script?.getAttribute('data-account') || 'acct_demo';
    const nonce = script?.getAttribute('data-csp-nonce') || undefined;
    const id = 'smb-widget-frame';

    const style = d.createElement('style');
    if(nonce) style.setAttribute('nonce', nonce);
    style.textContent = `#${id}{position:fixed;bottom:20px;right:20px;width:360px;height:520px;border:1px solid #ddd;border-radius:12px;z-index:999999;}`;
    d.head.appendChild(style);

    const iframe = d.createElement('iframe');
    iframe.id = id;
    iframe.setAttribute('title','Bookings');
    iframe.src = (window as any).WIDGET_APP_ORIGIN || 'about:blank';
    iframe.dataset.account = account;
    d.body.appendChild(iframe);
  });
})();
