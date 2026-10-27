/**
 * The preview frame's first script (L4.5, DESIGN §4g; critique B15): a classic script that runs before the bundle, so
 * whatever the bundle's module order, nothing in the frame ever sees the APIs removed or pinned here. Every pin is a
 * non-configurable, non-writable property: a later script cannot put the original back.
 *
 * - WebRTC is a network channel the frame's CSP does not cover (probe: 4 STUN packets left an opaque, CSP-locked frame):
 *   its constructors are deleted and pinned to `undefined`, as are WebTransport and `navigator.sendBeacon`.
 * - `<link rel="prerender">` is another (review A H1): Chrome's prerender of a link ignores the frame's CSP and sandbox
 *   (a third port got the frame's own path, an arbitrary host name was resolved). Every way to give an element a `rel`
 *   holding the token is refused (a TypeError): the `rel` property, its DOMTokenList (add, toggle, replace, value),
 *   setAttribute(NS), setAttributeNode(NS), NamedNodeMap.setNamedItem(NS), and an Attr's value / nodeValue /
 *   textContent. HTML parsing from a string — the other way to make such a link — is closed by the frame CSP's
 *   Trusted Types (no policy: innerHTML, insertAdjacentHTML, document.write, DOMParser, srcdoc… throw); the parsers it
 *   does not cover are removed here: XSLTProcessor, an XMLHttpRequest answering a document, execCommand('insertHTML'),
 *   setHTML / parseHTML.
 * - No child browsing context (review A L2): a child frame (an `about:blank` or `srcdoc` iframe) is a fresh realm with
 *   none of these pins and WebRTC back. Elements that make one (iframe, frame, object, embed, fencedframe, portal) are
 *   refused at creation, and custom elements cannot be defined (a customised built-in would make one without
 *   createElement). The bundle itself refuses to start outside the frame document (frame-main.tsx).
 *
 * The originals and the few built-ins the checks use are captured before any other script runs: a script that later
 * replaces Reflect.apply, String or a prototype method cannot reach an original through them, and every value is
 * converted to a string once (the original receives that string: no second toString).
 */
const apply = Reflect.apply;
const defineProperty = Object.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const Str = String;
const toLower = String.prototype.toLowerCase;
const indexOf = String.prototype.indexOf;
const lastIndexOf = String.prototype.lastIndexOf;
const slice = String.prototype.slice;
const nodeTypeOf = getOwnPropertyDescriptor(Node.prototype, 'nodeType')!.get!;
const attrNameOf = (getOwnPropertyDescriptor(Attr.prototype, 'localName') ?? getOwnPropertyDescriptor(Attr.prototype, 'name'))!.get!;
const attrValueOf = getOwnPropertyDescriptor(Attr.prototype, 'value')!.get!;
const ATTRIBUTE_NODE = 2;

const REMOVED = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'WebTransport', 'XSLTProcessor'] as const;
/** Elements that make a child browsing context (a fresh realm). */
const FRAME_TAGS = ['iframe', 'frame', 'frameset', 'object', 'embed', 'fencedframe', 'portal'];

const lower = (v: string): string => apply(toLower, v, []) as string;
const hasPrerender = (v: string): boolean => (apply(indexOf, lower(v), ['prerender']) as number) >= 0;
/** The local part of a name, lower-cased ("xlink:rel" → "rel"). */
const localOf = (name: string): string => {
  const n = lower(name);
  const colon = apply(lastIndexOf, n, [':']) as number;
  return colon >= 0 ? (apply(slice, n, [colon + 1]) as string) : n;
};
const refuse = (): never => {
  throw new TypeError('the preview frame refuses rel="prerender" (DESIGN §4g)');
};

function pin(target: object, key: string): void {
  try {
    delete (target as Record<string, unknown>)[key];
    defineProperty(target, key, { value: undefined, configurable: false, writable: false, enumerable: false });
  } catch {
    // Already pinned (a second run of this script): nothing to do.
  }
}

/** Replace a method by one that first checks (and converts) its arguments, then calls the original with them. */
function guardMethod(proto: object | undefined, key: string, check: (args: unknown[]) => unknown[]): void {
  const d = proto ? getOwnPropertyDescriptor(proto, key) : undefined;
  if (!proto || !d || typeof d.value !== 'function' || !d.configurable) return;
  const original = d.value as (...a: unknown[]) => unknown;
  defineProperty(proto, key, {
    value: function (this: unknown, ...args: unknown[]) {
      return apply(original, this, check(args));
    },
    configurable: false,
    writable: false,
    enumerable: d.enumerable ?? false,
  });
}

/** Replace a setter by one that first checks (and converts) the value. */
function guardSetter(proto: object | undefined, key: string, check: (self: unknown, v: unknown) => unknown): void {
  const d = proto ? getOwnPropertyDescriptor(proto, key) : undefined;
  if (!proto || !d || !d.set || !d.configurable) return;
  const set = d.set;
  defineProperty(proto, key, {
    get: d.get,
    set: function (this: unknown, v: unknown) {
      apply(set, this, [check(this, v)]);
    },
    configurable: false,
    enumerable: d.enumerable ?? false,
  });
}

/** A value converted once to a string, refused when it holds the token. */
const tokenValue = (v: unknown): string => {
  const s = Str(v);
  if (hasPrerender(s)) refuse();
  return s;
};
/** An attribute's name and value converted once, refused when the attribute is a `rel` holding the token. */
const attrValue = (name: unknown, v: unknown): [string, string] => {
  const n = Str(name);
  const s = Str(v);
  if (localOf(n) === 'rel' && hasPrerender(s)) refuse();
  return [n, s];
};
const isAttr = (self: unknown): boolean => {
  try {
    return apply(nodeTypeOf, self, []) === ATTRIBUTE_NODE;
  } catch {
    return false;
  }
};
/** An Attr node about to be attached: refused when it is a `rel` holding the token. */
const attrNode = (a: unknown): void => {
  if (isAttr(a)) attrValue(apply(attrNameOf, a, []), apply(attrValueOf, a, []));
};

// ── WebRTC, WebTransport, sendBeacon, XSLT ──────────────────────────────────
for (const key of REMOVED) pin(window, key);
pin(Navigator.prototype, 'sendBeacon');
pin(navigator, 'sendBeacon');

// ── rel="prerender" ─────────────────────────────────────────────────────────
guardSetter(HTMLLinkElement.prototype, 'rel', (_self, v) => tokenValue(v));
guardMethod(DOMTokenList.prototype, 'add', (args) => args.map(tokenValue));
guardMethod(DOMTokenList.prototype, 'toggle', (args) => (args.length ? [tokenValue(args[0]), ...args.slice(1)] : args));
guardMethod(DOMTokenList.prototype, 'replace', (args) => (args.length >= 2 ? [args[0], tokenValue(args[1]), ...args.slice(2)] : args));
guardSetter(DOMTokenList.prototype, 'value', (_self, v) => tokenValue(v));
guardMethod(Element.prototype, 'setAttribute', (args) => (args.length >= 2 ? [...attrValue(args[0], args[1]), ...args.slice(2)] : args));
guardMethod(Element.prototype, 'setAttributeNS', (args) => (args.length >= 3 ? [args[0], ...attrValue(args[1], args[2]), ...args.slice(3)] : args));
for (const key of ['setAttributeNode', 'setAttributeNodeNS']) guardMethod(Element.prototype, key, (args) => (attrNode(args[0]), args));
for (const key of ['setNamedItem', 'setNamedItemNS']) guardMethod(NamedNodeMap.prototype, key, (args) => (attrNode(args[0]), args));
guardSetter(Attr.prototype, 'value', (self, v) => attrValue(apply(attrNameOf, self, []), v)[1]);
for (const key of ['nodeValue', 'textContent']) {
  guardSetter(Node.prototype, key, (self, v) => (v === null || !isAttr(self) ? v : attrValue(apply(attrNameOf, self, []), v)[1]));
}

// ── HTML parsers Trusted Types does not cover ───────────────────────────────
guardSetter(XMLHttpRequest.prototype, 'responseType', (_self, v) => {
  const s = Str(v);
  if (s === 'document') throw new TypeError('the preview frame parses no document');
  return s;
});
{
  const d = getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseXML');
  if (d?.configurable) defineProperty(XMLHttpRequest.prototype, 'responseXML', { get: () => null, configurable: false, enumerable: d.enumerable ?? false });
}
guardMethod(Document.prototype, 'execCommand', (args) => {
  if (lower(Str(args[0])) === 'inserthtml') throw new TypeError('the preview frame parses no HTML');
  return args;
});
pin(Element.prototype, 'setHTML');
if (typeof ShadowRoot === 'function') pin(ShadowRoot.prototype, 'setHTML');
pin(Document, 'parseHTML');

// ── No child browsing context ───────────────────────────────────────────────
const frameTag = (name: unknown): string => {
  const s = Str(name);
  const n = localOf(s);
  for (const t of FRAME_TAGS) if (n === t) throw new TypeError(`the preview frame makes no <${t}>`);
  return s;
};
guardMethod(Document.prototype, 'createElement', (args) => [frameTag(args[0]), ...args.slice(1)]);
guardMethod(Document.prototype, 'createElementNS', (args) => [args[0], frameTag(args[1]), ...args.slice(2)]);
if (typeof CustomElementRegistry === 'function') {
  guardMethod(CustomElementRegistry.prototype, 'define', () => {
    throw new TypeError('the preview frame defines no custom element');
  });
}
