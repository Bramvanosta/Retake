// Transactional emails of the fixture (fictional brand): the sign-up confirmation, as a 600 px table layout with the
// logo as an inline (cid:) image — like a real mailer would send it.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e2cf"/><stop offset="1" stop-color="#d9bfa3"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M16 6.5c5 0 8 4.2 8 9.5s-3.4 9.5-8 9.5-8-4.2-8-9.5 3-9.5 8-9.5Z" fill="#3a2520"/><path d="M16.8 8c-3.1 3.2-3.2 6.3-.7 9.3 2.3 2.8 2.1 5.8-.8 8.8" fill="none" stroke="#e9d3bd" stroke-width="1.9" stroke-linecap="round"/></svg>`;

/** @param {{ cafe: string, name: string, email: string, link: string }} s */
export function confirmationEmail(s) {
  const first = s.name.split(/\s+/)[0] || s.name;
  const subject = 'Confirm your email to open your café account';
  const text = [
    `Hi ${first},`,
    '',
    `Welcome to Northfield! Confirm your email to open the account of ${s.cafe} and request your first quote.`,
    '',
    `Confirm my email: ${s.link}`,
    '',
    'Once confirmed you can browse the lots of the season, request quotes with your delivery window and follow',
    'every proposal from the roasters in one place.',
    '',
    'The link is valid for 24 hours. If you did not create an account, ignore this message.',
    '',
    '— Northfield, specialty coffee roasted to order for cafés',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4efe9;font-family:Inter,'Segoe UI',Helvetica,Arial,sans-serif;color:#2a1d1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4efe9;padding:28px 0">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(60,30,20,.08)">
  <tr><td style="background:#6b1e2a;padding:26px 36px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle"><img src="cid:northfield-logo" width="40" height="40" alt="" style="display:block;border:0"></td>
      <td style="vertical-align:middle;padding-left:12px;color:#f6e7d8;font-size:20px;font-weight:600;letter-spacing:-.01em">Northfield</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:38px 36px 8px">
    <p style="margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a2332;font-weight:600">One last step</p>
    <h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:32px;line-height:1.15;color:#1f1413">Confirm your email, ${esc(first)}</h1>
    <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#4a3c38">Welcome to Northfield! Confirm your email to open the account of <b>${esc(s.cafe)}</b> and request your first quote.</p>
  </td></tr>
  <tr><td style="padding:10px 36px 30px">
    <a href="${esc(s.link)}" style="display:inline-block;background:#8a2332;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:15px 30px;border-radius:10px">Confirm my email</a>
  </td></tr>
  <tr><td style="padding:0 36px 34px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf6f1;border:1px solid #efe6dc;border-radius:10px">
      <tr><td style="padding:18px 20px;font-size:14.5px;line-height:1.6;color:#4a3c38">
        <b style="color:#1f1413">What you can do next</b><br>
        <span style="color:#8a2332">•</span>&nbsp; Browse this season’s lots, roasted to order<br>
        <span style="color:#8a2332">•</span>&nbsp; Request quotes with your delivery window<br>
        <span style="color:#8a2332">•</span>&nbsp; Follow every proposal from the roasters in one place
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 36px 34px;font-size:13px;line-height:1.6;color:#8a7d75">The link is valid for 24 hours. If you did not create an account, you can ignore this message.</td></tr>
  <tr><td style="background:#faf6f1;padding:18px 36px;font-size:12px;color:#9a8d85">Northfield · Specialty coffee, roasted to order for cafés · Gothenburg</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html, inline: [{ cid: 'northfield-logo', type: 'image/svg+xml', name: 'logo.svg', data: Buffer.from(LOGO_SVG) }] };
}
