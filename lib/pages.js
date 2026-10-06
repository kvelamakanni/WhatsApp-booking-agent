// Tiny HTML pages shown in the guest's browser after Stripe redirects them
// back. Only static strings are ever passed in — nothing from the request is
// echoed into the page.

const TONES = {
  ok: { color: '#16a34a', icon: '✓' },
  warn: { color: '#d97706', icon: '!' },
  error: { color: '#dc2626', icon: '✕' },
};

function sendPage(res, status, { title, message, tone = 'ok' }) {
  const { color, icon } = TONES[tone];
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f1f5f9; font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .card { background: #fff; max-width: 380px; margin: 1rem; padding: 2.2rem 1.8rem; border-radius: 16px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.08); text-align: center; }
  .badge { width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 1rem; background: ${color};
           color: #fff; font-size: 28px; line-height: 56px; font-weight: 700; }
  h1 { font-size: 1.25rem; color: #0f172a; margin: 0 0 0.6rem; }
  p { font-size: 0.95rem; color: #475569; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`);
}

module.exports = { sendPage };
