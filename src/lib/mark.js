// The Monolito mark: MINITRON as it looks in its bubble while it works, a
// little pyramid on tank treads with one round eye, ported from
// Minitron/minitron/persona.py (draw_pyramid). Drawn with Cairo in one
// color so the state can tint it. No imports, so the tools can render it too.

function rounded(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// Paints the pyramid in a unit square, in `rgba`.
function paintPyramid(cr, rgba) {
    const [r, g, b, a] = rgba;
    // treads: the body color, darkened
    rounded(cr, 0.08, 0.72, 0.84, 0.2, 0.1);
    cr.setSourceRGBA(r * 0.5, g * 0.5, b * 0.5, a);
    cr.fill();
    // two faces, the right one in shade
    cr.setSourceRGBA(r, g, b, a);
    cr.moveTo(0.5, 0.06);
    cr.lineTo(0.14, 0.72);
    cr.lineTo(0.86, 0.72);
    cr.closePath();
    cr.fill();
    cr.setSourceRGBA(r * 0.76, g * 0.76, b * 0.76, a);
    cr.moveTo(0.5, 0.06);
    cr.lineTo(0.6, 0.72);
    cr.lineTo(0.86, 0.72);
    cr.closePath();
    cr.fill();
    // the eye: a white visor, as at small sizes in the bubble
    rounded(cr, 0.47 - 0.14, 0.47 - 0.055, 0.28, 0.11, 0.055);
    cr.setSourceRGBA(1, 1, 1, 0.95 * a);
    cr.fill();
}

// Fills the mark in `rgba`, centered in a width x height square.
export function drawMark(cr, width, height, rgba) {
    const size = Math.min(width, height);
    cr.save();
    cr.translate(Math.round((width - size) / 2), Math.round((height - size) / 2));
    cr.scale(size, size);
    paintPyramid(cr, rgba);
    cr.restore();
}
