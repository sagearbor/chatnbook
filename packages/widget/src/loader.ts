// Minimal async loader that injects the widget iframe
(function(){
  const d = document;
  function ready(fn){ if(d.readyState!='loading'){fn()} else {d.addEventListener('DOMContentLoaded',fn)} }
  ready(() => {
    const account = document.currentScript?.getAttribute('data-account') || 'acct_demo';
    const iframe = d.createElement('iframe');
    iframe.setAttribute('title','Bookings');
    iframe.style.position='fixed'; iframe.style.bottom='20px'; iframe.style.right='20px';
    iframe.style.width='360px'; iframe.style.height='520px'; iframe.style.border='1px solid #ddd'; iframe.style.borderRadius='12px'; iframe.style.zIndex='999999';
    iframe.src = (window as any).WIDGET_APP_ORIGIN || 'about:blank';
    d.body.appendChild(iframe);
  });
})();
