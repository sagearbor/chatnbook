// Async loader injecting a launcher button + the widget iframe, CSP-friendly.
//
// Embedded on customer sites as a plain classic script tag:
//   <script src="https://<api>/widget.js" data-account="acct_demo" async></script>
//
// The widget app itself (app.html/app.js/a11y.js) is served by the SAME API
// origin as this script (GET /widget/app.html etc alongside GET /widget.js),
// so the iframe origin is derived from the loader's own <script src> rather
// than requiring a second data attribute. window.WIDGET_APP_ORIGIN remains a
// manual override (useful for local dev / tests), and the page's own origin
// is the last-resort fallback.
(function(){
  const d = document;
  // Capture synchronously: document.currentScript is only set while this
  // script is executing. Reading it inside the deferred DOMContentLoaded
  // callback below (when the page was still loading) would return null,
  // losing data-account and the API origin for an `async` WordPress embed.
  const script = d.currentScript as HTMLScriptElement | null;
  function ready(fn: () => void){ if(d.readyState!='loading'){fn()} else {d.addEventListener('DOMContentLoaded',fn)} }
  ready(() => {
    const account = script?.getAttribute('data-account') || 'acct_demo';
    const nonce = script?.getAttribute('data-csp-nonce') || undefined;
    const params = new URLSearchParams(window.location.search);
    const agent = params.get('agent') === '1';
    const autoOpen = agent || params.get('smb') === 'open';
    const frameId = 'smb-widget-frame';
    const buttonId = 'smb-widget-button';

    let origin = (window as any).WIDGET_APP_ORIGIN as string | undefined;
    if (!origin && script?.src) {
      try { origin = new URL(script.src).origin; } catch { /* fall through */ }
    }
    if (!origin) origin = window.location.origin;

    let src = `${origin}/widget/app.html?account=${encodeURIComponent(account)}`;
    if (agent) src += '&agent=1';
    src += `&api=${encodeURIComponent(origin)}`;

    const style = d.createElement('style');
    if(nonce) style.setAttribute('nonce', nonce);
    style.textContent = `
      #${buttonId}{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;
        background:#111827;color:#fff;border:none;box-shadow:0 4px 14px rgba(0,0,0,.25);
        font-size:24px;line-height:56px;text-align:center;cursor:pointer;z-index:999998;padding:0;}
      #${buttonId}:hover{background:#1f2937;}
      #${frameId}{position:fixed;bottom:88px;right:20px;width:360px;height:520px;max-width:100vw;
        max-height:calc(100vh - 108px);border:1px solid #ddd;border-radius:12px;z-index:999999;
        box-shadow:0 8px 30px rgba(0,0,0,.2);display:none;background:#fff;}
      #${frameId}[data-smb-open="1"]{display:block;}
      @media (max-width:480px){
        #${frameId}{right:0;bottom:0;left:0;top:0;width:100vw;height:100vh;max-height:100vh;
          border-radius:0;border:none;}
        #${buttonId}{bottom:16px;right:16px;}
      }
    `;
    d.head.appendChild(style);

    const button = d.createElement('button');
    button.id = buttonId;
    button.type = 'button';
    button.setAttribute('aria-label', 'Book an appointment');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = '📅';

    const iframe = d.createElement('iframe');
    iframe.id = frameId;
    iframe.setAttribute('title', 'Bookings');
    iframe.src = src;
    iframe.dataset.account = account;
    if (agent) iframe.dataset.agent = '1';
    iframe.dataset.smbOpen = '0';

    function setOpen(open: boolean) {
      iframe.dataset.smbOpen = open ? '1' : '0';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? '✕' : '📅';
    }

    button.addEventListener('click', () => {
      setOpen(iframe.dataset.smbOpen !== '1');
    });

    d.body.appendChild(button);
    d.body.appendChild(iframe);

    if (autoOpen) setOpen(true);
  });
})();
