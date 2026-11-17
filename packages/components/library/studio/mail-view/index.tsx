import {
  Background,
  CapText,
  Img,
  SYSTEM_COLORS,
  biasMotion,
  capTextLayout,
  cardShadow,
  clamp,
  cssFontFamily,
  darkLight,
  easing,
  formatMetrics,
  mixColors,
  progress,
  readableOn,
  roundTo,
  useCurrentFrame,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, EmailMedia } from '@retake/components/kit';

type Params = { width: number; sidebar: boolean; scroll: 'auto' | 'none'; shadow: 'none' | 'soft' | 'strong' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-12T09:41:00Z" → "12 Oct 2026, 09:41": the date's own digits, without a locale or a time zone. */
export function mailDate(iso: string | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}${m[4] ? `, ${m[4]}:${m[5]}` : ''}`;
}

/** Intl's narrow and no-break spaces as plain ones, its direction marks dropped (a Latin theme font has neither). */
const plainText = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ').replace(/[\u200e\u200f\u061c]/g, '');

/** `locale` when this Intl knows it (a tag it does not know would quietly become the host's default: not deterministic). */
function knownLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale])[0];
  } catch {
    return undefined;
  }
}

/** The wall time of `at` in `timeZone` as `mailDate` writes one ("17 Nov 2026, 19:56"); null for a zone Intl does not know. */
function digitsIn(at: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const v = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return mailDate(`${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}`);
  } catch {
    return null;
  }
}

/**
 * What the card shows of a mail's date: `full` in the header, `time` in the inbox column. The slot `date` is shown as
 * written. A captured mail carries the zone and locale of the take's browser (and its date on the product's clock when
 * the run had one): its date is written as the filmed pages write dates — in that zone, in that locale's medium date and
 * short time; a locale this Intl does not know (or none) keeps `mailDate`'s words, in that zone. Without a zone (a take
 * before they were recorded, a sample), a zone Intl does not know or a date without a time: the date's own digits.
 */
export function mailDates(email: Pick<EmailMedia, 'date' | 'timezone' | 'locale'> | undefined, slot?: string): { full: string; time: string } {
  const split = (full: string) => ({ full, time: full.split(',').pop()?.trim() ?? full });
  if (slot !== undefined) return split(slot);
  const own = split(mailDate(email?.date));
  const at = email?.date && /T\d{2}:\d{2}/.test(email.date) ? Date.parse(email.date) : Number.NaN;
  if (!email?.timezone || Number.isNaN(at)) return own;
  const locale = knownLocale(email.locale);
  if (!locale) {
    const digits = digitsIn(at, email.timezone);
    return digits ? split(digits) : own;
  }
  try {
    const full = new Intl.DateTimeFormat(locale, { timeZone: email.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
    const time = new Intl.DateTimeFormat(locale, { timeZone: email.timezone, timeStyle: 'short' }).format(at);
    return { full: plainText(full), time: plainText(time) };
  } catch {
    return own;
  }
}

/** The toolbar's mailbox: "Inbox", or the inbox of the persona the mail was waited for in ("buyer" → "Inbox · Buyer"). */
export function mailboxLabel(persona: string | undefined): string {
  if (!persona) return 'Inbox';
  const name = persona.replace(/[_-]+/g, ' ').trim();
  return `Inbox · ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** Initials of a sender ("Northfield Roasters" → "NR", "hello@x.com" → "H"). */
export function initials(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?')[0]).toUpperCase();
}

/**
 * A mail window on the theme background: toolbar (window controls, mailbox), an inbox column with the message selected
 * (landscape / square), then the message header and its rendered HTML from its top — with `scroll: auto`, scrolled from
 * top to bottom (eased) when it is taller than the pane. Without a captured image the body text is set in the body font.
 */
export default function MailView({ theme, slots, params, unit, width, height, fps, durationInFrames, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const e: EmailMedia | undefined = media?.email?.kind === 'email' ? media.email : undefined;
  const from = slots.from ?? e?.from_name ?? e?.from ?? '';
  const address = slots.address ?? (e && e.from !== from ? e.from : undefined);
  const subject = slots.subject ?? e?.subject ?? '';
  const date = mailDates(e, slots.date);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(light, theme.colors.text, dark, 4.5);
  const muted = readableOn(light, theme.colors.muted, ink, 3);
  const accent = readableOn(light, theme.colors.accent, ink, 2.6);
  const chrome = mixColors(light, dark, 0.05);
  const line = withAlpha(ink, 0.1);
  const body = cssFontFamily(theme.fonts.body);

  // Window geometry (output px).
  const margin = (variant === 'landscape' ? 60 : 40) * unit;
  const W = Math.min(params.width * unit, width - 2 * margin);
  const H = Math.min((variant === 'vertical' ? 1500 : 940) * unit, height - 2 * margin);
  const X = (width - W) / 2;
  const Y = (height - H) / 2;
  const radius = 18 * unit;
  const toolbar = 54 * u;
  const sidebar = params.sidebar && variant !== 'vertical' ? Math.min(330 * u, W * 0.28) : 0;
  const paneX = sidebar;
  const paneW = W - sidebar;
  const pad = 40 * u;

  // Header.
  const subjectL = capTextLayout({ text: subject || ' ', width: paneW - 2 * pad, maxFontSize: 36 * u, minFontSize: 24 * u, maxLines: 2, lineHeight: 1.15, fontFamily: theme.fonts.display });
  const avatar = 46 * u;
  const headerTop = toolbar + 30 * u;
  const senderTop = headerTop + subjectL.band + 26 * u;
  const headerH = senderTop + avatar + 26 * u;
  const viewTop = headerH;
  const viewH = H - viewTop;

  // Body: the rendered email (600 px layout) shown ~ 1.1× in landscape, the pane's width in narrow formats.
  const img = e?.image;
  const imgW = Math.min(paneW - 2 * pad, 680 * u);
  const imgH = img ? (imgW * img.height) / img.width : 0;
  const travel = Math.max(0, imgH - (viewH - 24 * u));
  const t0 = 1.2;
  const t1 = Math.max(t0 + 0.5, durationInFrames / fps - 0.8);
  const sp = params.scroll === 'auto' && travel > 0 ? easing('easeInOut')(clamp((frame / fps - t0) / (t1 - t0))) : 0;
  const scrollY = roundTo(-travel * sp, 2);

  const enter = progress(frame, fps, { duration: 0.5 * bias.pace, ease: 'entrance' });
  const inner = progress(frame, fps, { delay: 0.2, duration: 0.45 * bias.pace, ease: 'entrance' });
  const rise = roundTo((1 - enter) * 24 * bias.travel * unit, 2);

  const rows = [0, 1, 2, 3];
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: X,
          top: Y,
          width: W,
          height: H,
          borderRadius: radius,
          overflow: 'hidden',
          background: light,
          boxShadow: cardShadow(theme, params.shadow, unit),
          opacity: roundTo(Math.min(1, enter * 1.4), 4),
          transform: `translateY(${rise}px)`,
          fontFamily: body,
          color: ink,
        }}
      >
        {/* Toolbar. */}
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: toolbar, background: chrome, borderBottom: `${Math.max(1, unit)}px solid ${line}` }}>
          {[SYSTEM_COLORS.close, SYSTEM_COLORS.minimize, SYSTEM_COLORS.zoom].map((c, i) => (
            <div key={c} style={{ position: 'absolute', left: (22 + i * 22) * u, top: toolbar / 2 - 6.5 * u, width: 13 * u, height: 13 * u, borderRadius: 7 * u, background: c }} />
          ))}
          <div style={{ position: 'absolute', left: (sidebar || 110 * u) + pad, top: 0, height: toolbar, lineHeight: `${roundTo(toolbar, 2)}px`, fontSize: 16 * u, fontWeight: 600, color: muted }}>
            {slots.mailbox ?? mailboxLabel(e?.persona)}
          </div>
          {[0, 1, 2].map((i) => (
            <svg key={i} width={20 * u} height={20 * u} viewBox="0 0 20 20" style={{ position: 'absolute', right: (28 + i * 40) * u, top: toolbar / 2 - 10 * u }}>
              {i === 0 ? <path d="M3 6h14M3 10h14M3 14h9" stroke={muted} strokeWidth="1.6" strokeLinecap="round" /> : null}
              {i === 1 ? <path d="M8 5 3 10l5 5M3 10h9a5 5 0 0 1 5 5" fill="none" stroke={muted} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
              {i === 2 ? <path d="M3 5h14v10H3zM3 5l7 6 7-6" fill="none" stroke={muted} strokeWidth="1.5" strokeLinejoin="round" /> : null}
            </svg>
          ))}
        </div>
        {/* Inbox column: the message selected, quiet placeholder rows below. */}
        {sidebar > 0 ? (
          <div style={{ position: 'absolute', left: 0, top: toolbar, width: sidebar, bottom: 0, background: chrome, borderRight: `${Math.max(1, unit)}px solid ${line}`, opacity: roundTo(inner, 4) }}>
            {rows.map((i) => {
              const top = (14 + i * 92) * u;
              const sel = i === 0;
              return (
                <div key={i} style={{ position: 'absolute', left: 12 * u, right: 12 * u, top, height: 80 * u, borderRadius: 10 * u, background: sel ? withAlpha(accent, 0.12) : 'transparent' }}>
                  {sel ? (
                    <>
                      <div style={{ position: 'absolute', left: 16 * u, top: 12 * u, right: 64 * u, fontSize: 15 * u, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{from}</div>
                      <div style={{ position: 'absolute', right: 14 * u, top: 13 * u, fontSize: 12.5 * u, color: muted }}>{date.time}</div>
                      <div style={{ position: 'absolute', left: 16 * u, top: 34 * u, right: 14 * u, fontSize: 14 * u, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subject}</div>
                      <div style={{ position: 'absolute', left: 16 * u, top: 55 * u, right: 14 * u, fontSize: 13 * u, color: muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e?.preview ?? slots.body ?? ''}</div>
                      <div style={{ position: 'absolute', left: 4 * u, top: 16 * u, width: 6 * u, height: 6 * u, borderRadius: 3 * u, background: accent }} />
                    </>
                  ) : (
                    <>
                      <div style={{ position: 'absolute', left: 16 * u, top: 16 * u, width: (110 + 30 * (i % 2)) * u, height: 10 * u, borderRadius: 5 * u, background: withAlpha(ink, 0.12) }} />
                      <div style={{ position: 'absolute', left: 16 * u, top: 38 * u, width: (190 - 20 * i) * u, height: 9 * u, borderRadius: 5 * u, background: withAlpha(ink, 0.08) }} />
                      <div style={{ position: 'absolute', left: 16 * u, top: 57 * u, width: (150 + 15 * i) * u, height: 9 * u, borderRadius: 5 * u, background: withAlpha(ink, 0.06) }} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
        {/* Message pane. */}
        <div style={{ position: 'absolute', left: paneX, top: 0, width: paneW, height: H, overflow: 'hidden', opacity: roundTo(inner, 4) }}>
          <CapText layout={subjectL} x={pad} capTop={headerTop} color={ink} />
          <div style={{ position: 'absolute', left: pad, top: senderTop, width: avatar, height: avatar, borderRadius: avatar / 2, background: mixColors(theme.colors.accent, light, 0.15), color: readableOn(theme.colors.accent, light, dark, 3), fontSize: 18 * u, fontWeight: 600, lineHeight: `${roundTo(avatar, 2)}px`, textAlign: 'center' }}>
            {initials(from || address || '?')}
          </div>
          <div style={{ position: 'absolute', left: pad + avatar + 14 * u, top: senderTop + 1 * u, right: pad + 220 * u, fontSize: 17 * u, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {from}
            {address ? <span style={{ fontWeight: 400, color: muted, marginLeft: 8 * u }}>&lt;{address}&gt;</span> : null}
          </div>
          <div style={{ position: 'absolute', left: pad + avatar + 14 * u, top: senderTop + 25 * u, fontSize: 14 * u, color: muted }}>
            {e?.to?.length ? `To: ${e.to.join(', ')}` : 'To: me'}
          </div>
          <div style={{ position: 'absolute', right: pad, top: senderTop + 2 * u, fontSize: 14 * u, color: muted }}>{date.full}</div>
          <div style={{ position: 'absolute', left: pad, right: pad, top: viewTop - 1 * u, height: Math.max(1, unit), background: line }} />
          {/* Body viewport. */}
          <div style={{ position: 'absolute', left: 0, top: viewTop, width: paneW, height: viewH, overflow: 'hidden', background: img ? SYSTEM_COLORS.page : light }}>
            {img ? (
              <Img src={img.url} style={{ position: 'absolute', left: (paneW - imgW) / 2, top: 12 * u + scrollY, width: imgW, height: imgH, display: 'block' }} />
            ) : (
              <div style={{ position: 'absolute', left: pad, right: pad, top: 26 * u, fontSize: 19 * u, lineHeight: 1.55, color: ink, whiteSpace: 'pre-wrap' }}>
                {slots.body ?? e?.preview ?? ''}
              </div>
            )}
          </div>
        </div>
      </div>
    </Background>
  );
}
