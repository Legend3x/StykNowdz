/** The starter drawings for a 2D face (docs/FACE-RIG.md): eyes, a pupil,
 * brows, lip-sync mouths and two extras, drawn with a 2D canvas so each fits
 * its feature's box. They are ordinary drawings: paint over or replace them.
 *
 * `starterArt(kind, width, height, canvas)` returns the states (and an eye's
 * pupil) for one feature; `canvas(w, h)` makes a canvas with toDataURL. */

const INK = '#2b1f1d', WHITE = '#fffdf9', MOUTH = '#5a1e24', TONGUE = '#d96470', TEETH = '#ffffff';

function picture(canvas, w, h, paint) {
  const c = canvas(w, h), g = c.getContext('2d');
  g.lineCap = 'round'; g.lineJoin = 'round';
  paint(g, w, h);
  return c.toDataURL('image/png');
}
/** An almond (eye) path across the box: corners at the sides, lids bulging up and down. */
function almond(g, w, h, {top = .36, bottom = .3, cy = .5, span = .4} = {}) {
  const l = w * (.5 - span), r = w * (.5 + span), y = h * cy;
  g.beginPath(); g.moveTo(l, y);
  g.bezierCurveTo(l + w * .12, y - h * top * 1.35, r - w * .14, y - h * top * 1.35, r, y);
  g.bezierCurveTo(r - w * .14, y + h * bottom * 1.35, l + w * .12, y + h * bottom * 1.35, l, y);
  g.closePath();
}
const line = (h, k = 1) => Math.max(1.5, h * .06 * k);

function eye(canvas, w, h) {
  const lw = line(h);
  const lids = (g, opts, lash = true) => {
    almond(g, w, h, opts); g.strokeStyle = INK; g.lineWidth = lw; g.stroke();
    // A heavier upper lid with a flick at the outer corner (the viewer's left: the left eye's outside).
    const {top = .36, cy = .5, span = .4} = opts, l = w * (.5 - span), r = w * (.5 + span), y = h * cy;
    g.beginPath(); g.moveTo(r, y); g.bezierCurveTo(r - w * .14, y - h * top * 1.35, l + w * .12, y - h * top * 1.35, l, y);
    g.lineWidth = lw * 1.9; g.stroke();
    if (lash) { g.beginPath(); g.moveTo(l + w * .02, y - h * .02); g.lineTo(l - w * .06, y - h * .14); g.lineWidth = lw * 1.4; g.stroke(); }
  };
  const white = opts => picture(canvas, w, h, g => { almond(g, w, h, opts); g.fillStyle = WHITE; g.fill(); });
  const open = {top: .36, bottom: .3}, wide = {top: .44, bottom: .38, span: .42};
  // Half open: the white below a lid line through the middle.
  const half = {top: .1, bottom: .3, cy: .56};
  const arc = (up) => picture(canvas, w, h, g => {
    g.strokeStyle = INK; g.lineWidth = lw * 1.8; g.beginPath();
    const l = w * .12, r = w * .88, y = h * .5, b = h * (up ? -.34 : .3);
    g.moveTo(l, y); g.quadraticCurveTo(w / 2, y + b, r, y); g.stroke();
    if (!up) for (const k of [.25, .5, .75]) { const x = l + (r - l) * k, yy = y + b * 2 * k * (1 - k) * 1; g.beginPath(); g.moveTo(x, yy); g.lineTo(x - w * .02, yy + h * .14); g.lineWidth = lw; g.stroke(); }
    g.beginPath(); g.moveTo(l, y); g.lineTo(l - w * .06, y - h * .1); g.lineWidth = lw * 1.3; g.stroke();
  });
  const states = [
    {name: 'Open', under: white(open), over: picture(canvas, w, h, g => lids(g, open))},
    {name: 'Half', under: white(half), over: picture(canvas, w, h, g => lids(g, half))},
    {name: 'Closed', over: arc(false)},
    {name: 'Happy', over: arc(true)},
    {name: 'Wide', under: white(wide), over: picture(canvas, w, h, g => lids(g, wide, false))},
  ];
  const size = 128, pupil = picture(canvas, size, size, g => {
    const c = size / 2;
    g.fillStyle = '#3a5a8c'; g.beginPath(); g.arc(c, c, c * .96, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#121014'; g.beginPath(); g.arc(c, c, c * .55, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(c - c * .32, c - c * .36, c * .2, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(c + c * .3, c + c * .3, c * .09, 0, Math.PI * 2); g.fill();
  });
  return {states, pupil: {src: pupil, size: .42, range: [.26, .18]}};
}

function brow(canvas, w, h) {
  const over = picture(canvas, w, h, g => {
    // A tapered stroke: thick at the inner end (the viewer's right for the left brow), thin outside.
    g.fillStyle = INK; g.beginPath();
    g.moveTo(w * .06, h * .66);
    g.quadraticCurveTo(w * .45, h * .02, w * .94, h * .3);
    g.quadraticCurveTo(w * .96, h * .62, w * .9, h * .72);
    g.quadraticCurveTo(w * .45, h * .42, w * .06, h * .66);
    g.closePath(); g.fill();
  });
  return {states: [{name: 'Brow', over}]};
}

function mouth(canvas, w, h) {
  const lw = line(h, .8);
  const stroke = (g, path) => { g.strokeStyle = INK; g.lineWidth = lw; path(g); g.stroke(); };
  const curve = bend => picture(canvas, w, h, g => stroke(g, g => {
    g.beginPath(); g.moveTo(w * .2, h * .5 - h * bend * .2); g.quadraticCurveTo(w / 2, h * .5 + h * bend * .35, w * .8, h * .5 - h * bend * .2);
    // Little corners for a smile or frown.
    if (bend) { g.moveTo(w * .17, h * .5 - h * bend * .28); g.lineTo(w * .23, h * .5 - h * bend * .12); g.moveTo(w * .83, h * .5 - h * bend * .28); g.lineTo(w * .77, h * .5 - h * bend * .12); }
  }));
  // An open mouth: a dark shape with a tongue, optional teeth along the top, outlined.
  const open = (shape, {teeth = 0, tongue = .35} = {}) => picture(canvas, w, h, g => {
    shape(g); g.fillStyle = MOUTH; g.fill();
    g.save(); shape(g); g.clip();
    g.fillStyle = TONGUE; g.beginPath(); g.ellipse(w / 2, h * (1 - tongue * .5), w * .3, h * tongue, 0, 0, Math.PI * 2); g.fill();
    if (teeth) { g.fillStyle = TEETH; g.fillRect(0, 0, w, h * teeth); }
    g.restore();
    shape(g); g.strokeStyle = INK; g.lineWidth = lw; g.stroke();
  });
  const oval = (rx, ry, cy = .5) => g => { g.beginPath(); g.ellipse(w / 2, h * cy, w * rx, h * ry, 0, 0, Math.PI * 2); };
  const dShape = (top, depth, half) => g => { g.beginPath(); g.moveTo(w * (.5 - half), h * top); g.quadraticCurveTo(w / 2, h * (top - .06), w * (.5 + half), h * top); g.quadraticCurveTo(w * (.5 + half * .8), h * (top + depth), w / 2, h * (top + depth)); g.quadraticCurveTo(w * (.5 - half * .8), h * (top + depth), w * (.5 - half), h * top); g.closePath(); };
  return {states: [
    {name: 'Rest', over: curve(.12)},
    {name: 'Smile', over: curve(.7)},
    {name: 'Frown', over: curve(-.5)},
    {name: 'Open', over: open(dShape(.3, .5, .3), {teeth: .38})},
    {name: 'A', over: open(dShape(.16, .72, .3), {teeth: .25, tongue: .3})},
    {name: 'E', over: open(dShape(.34, .3, .36), {teeth: .5, tongue: .2})},
    {name: 'O', over: open(oval(.17, .3), {tongue: .25})},
    {name: 'U', over: open(oval(.1, .16), {tongue: .1})},
    {name: 'M', over: picture(canvas, w, h, g => { stroke(g, g => { g.beginPath(); g.moveTo(w * .24, h * .5); g.lineTo(w * .76, h * .5); }); g.globalAlpha = .45; stroke(g, g => { g.beginPath(); g.moveTo(w * .38, h * .6); g.quadraticCurveTo(w / 2, h * .66, w * .62, h * .6); }); })},
  ]};
}

function extra(canvas, w, h, id) {
  if (id === 'sweat') return {states: [{name: 'Sweat', over: picture(canvas, w, h, g => {
    g.beginPath(); g.moveTo(w / 2, h * .04); g.bezierCurveTo(w * .62, h * .3, w * .92, h * .55, w * .9, h * .7);
    g.arc(w / 2, h * .7, w * .4, 0, Math.PI); g.bezierCurveTo(w * .08, h * .55, w * .38, h * .3, w / 2, h * .04); g.closePath();
    g.fillStyle = '#9ad7ff'; g.fill(); g.strokeStyle = '#3c84b8'; g.lineWidth = line(w, .7); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.ellipse(w * .36, h * .66, w * .08, h * .1, -.4, 0, Math.PI * 2); g.fill();
  })}]};
  return {states: [{name: 'Blush', over: picture(canvas, w, h, g => {
    for (const cx of [.2, .8]) {
      const r = Math.min(w * .18, h * .5), grad = g.createRadialGradient(w * cx, h / 2, 0, w * cx, h / 2, r);
      grad.addColorStop(0, 'rgba(255,105,120,.6)'); grad.addColorStop(1, 'rgba(255,105,120,0)');
      g.save(); g.translate(w * cx, h / 2); g.scale(1.6, 1); g.translate(-w * cx, -h / 2);
      g.fillStyle = grad; g.beginPath(); g.arc(w * cx, h / 2, r, 0, Math.PI * 2); g.fill(); g.restore();
      g.strokeStyle = 'rgba(214,70,90,.55)'; g.lineWidth = Math.max(1, h * .05);
      for (const k of [-1, 0, 1]) { const x = w * cx + k * r * .45; g.beginPath(); g.moveTo(x + r * .12, h * .38); g.lineTo(x - r * .12, h * .62); g.stroke(); }
    }
  })}]};
}

/** The starter drawings for one feature, drawn `width` × `height` pixels. */
export function starterArt(kind, id, width, height, canvas) {
  const w = Math.max(8, Math.round(width)), h = Math.max(8, Math.round(height));
  if (kind === 'eye') return eye(canvas, w, h);
  if (kind === 'brow') return brow(canvas, w, h);
  if (kind === 'mouth') return mouth(canvas, w, h);
  return extra(canvas, w, h, id);
}
/** Drawing size for a feature box on a texture: about 256 pixels across its longer side. */
export function artSize(feature, texture, longest = 256) {
  const pw = Math.max(1, feature.w * texture.width), ph = Math.max(1, feature.h * texture.height), s = longest / Math.max(pw, ph);
  return [Math.round(pw * s), Math.round(ph * s)];
}
