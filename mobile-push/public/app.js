const installCard = document.getElementById('installCard');
const pairCard = document.getElementById('pairCard');
const codeCard = document.getElementById('codeCard');
const enableBtn = document.getElementById('enableBtn');
const enableStatus = document.getElementById('enableStatus');
const codeVal = document.getElementById('codeVal');
const codeStatus = document.getElementById('codeStatus');
const testBtn = document.getElementById('testBtn');
const unpairBtn = document.getElementById('unpairBtn');

const isStandalone = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function showCode(code) {
  codeVal.textContent = code;
  codeCard.classList.remove('hide');
  pairCard.classList.add('hide');
}

async function existingSubscription(reg) {
  try { return await reg.pushManager.getSubscription(); } catch (e) { return null; }
}

async function subscribe(reg) {
  const res = await fetch('/api/vapid-public-key');
  const { publicKey } = await res.json();
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
}

async function register(subscription) {
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription })
  });
  if (!res.ok) throw new Error('Server refused the subscription (' + res.status + ').');
  return res.json();
}

async function init() {
  if (!isStandalone) {
    installCard.classList.remove('hide');
    return;
  }
  installCard.classList.add('hide');

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pairCard.classList.remove('hide');
    document.getElementById('pairLede').textContent = 'This browser does not support push notifications.';
    enableBtn.disabled = true;
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const saved = localStorage.getItem('nudgeCode');
  const existing = await existingSubscription(reg);
  if (saved && existing) {
    showCode(saved);
    return;
  }

  pairCard.classList.remove('hide');

  enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    enableStatus.textContent = 'Asking for permission…';
    enableStatus.className = 'status';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        enableStatus.textContent = 'Notifications were not allowed. You can turn them on later in iOS Settings → Nudge → Notifications.';
        enableStatus.className = 'status err';
        enableBtn.disabled = false;
        return;
      }
      const sub = existing || await subscribe(reg);
      const { code } = await register(sub);
      localStorage.setItem('nudgeCode', code);
      showCode(code);
    } catch (e) {
      enableStatus.textContent = 'Could not enable notifications: ' + ((e && e.message) || e);
      enableStatus.className = 'status err';
      enableBtn.disabled = false;
    }
  });
}

testBtn && testBtn.addEventListener('click', async () => {
  const code = localStorage.getItem('nudgeCode');
  codeStatus.textContent = 'Sending…';
  codeStatus.className = 'status';
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, title: 'Nudge', body: 'Test notification — this phone is paired.', url: '/' })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    codeStatus.textContent = 'Sent. It should arrive any second.';
  } catch (e) {
    codeStatus.textContent = 'Failed: ' + ((e && e.message) || e);
    codeStatus.className = 'status err';
  }
});

unpairBtn && unpairBtn.addEventListener('click', async () => {
  const code = localStorage.getItem('nudgeCode');
  try {
    await fetch('/api/unpair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && await existingSubscription(reg);
    if (sub) await sub.unsubscribe();
  } catch (e) {}
  localStorage.removeItem('nudgeCode');
  codeCard.classList.add('hide');
  pairCard.classList.remove('hide');
  enableBtn.disabled = false;
  enableStatus.textContent = '';
});

init();
