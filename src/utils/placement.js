/**
 * Screen-space pin placement.
 *
 * Guarantees, at every zoom level:
 *  - no two rendered markers overlap (each keeps a breathing margin)
 *  - no pin covers a cluster bubble
 *  - the selected / compare projects and the top of the list keep the
 *    readable name pills
 *  - anything that cannot breathe is hidden rather than stacked
 *
 * Pure function of screen coordinates → render modes, so it can be unit
 * tested without a map instance.
 */

export const PILL_H     = 30   // rendered pill height (px)
export const PILL_GAP   = 8    // breathing room around a price pill (px)
export const DOT_SIZE   = 12   // rendered dot diameter (px)
export const DOT_GAP    = 7    // breathing room around a dot (px)
export const HOVER_ROOM = 6    // extra room so hover scaling never collides

/* Chips carry project names (mixed-case letters are wider than digits);
   a slight over-estimate is safe — the repair pass corrects the rest. */
export const estimatePillW = (label) => label.length * 7.9 + 26

export const intersects = (a, b) =>
  a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1

const rectAt = (pt, w, h) => ({
  x1: pt.x - w / 2, y1: pt.y - h / 2,
  x2: pt.x + w / 2, y2: pt.y + h / 2,
})

/**
 * @param entries      [{ id, x, y, label }] — viewport-filtered, in list order
 * @param priorityIds  selected / compare projects: placed first and never
 *                     hidden (they may sit over a bubble, never vanish)
 * @param fixed        [{ x, y, w, h }] — cluster bubbles every other pin
 *                     has to find room around
 * @returns { modes, order, hidden } — `order` is the priority sequence,
 *          reused by the DOM repair pass so demotions stay consistent.
 */
export function computePlacements(entries, { priorityIds = [], fixed = [] } = {}) {
  /* Priority: selected / compare picks → incoming (list sort) order */
  const rank = new Map(priorityIds.map((id, i) => [id, i]))
  const ordered = entries.map((e, i) => ({ ...e, i })).sort((a, b) => {
    const pd = (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    return pd !== 0 ? pd : a.i - b.i
  })

  const obstacles = fixed.map(f => rectAt(f, f.w + PILL_GAP, f.h + PILL_GAP))
  const placed = []
  const modes  = new Map()
  const leftovers = []
  const blocked = (rect, e) =>
    placed.some(r => intersects(rect, r)) ||
    (!rank.has(e.id) && obstacles.some(r => intersects(rect, r)))

  // Tier 1 — name chips
  for (const e of ordered) {
    const rect = rectAt(e, estimatePillW(e.label) + PILL_GAP, PILL_H + PILL_GAP)
    if (blocked(rect, e)) {
      leftovers.push(e)
    } else {
      placed.push(rect)
      modes.set(e.id, 'pill')
    }
  }

  // Tier 2 — dots (tested against chips, dots *and* bubbles)
  const dotBox = DOT_SIZE + DOT_GAP + HOVER_ROOM
  let hidden = 0
  for (const e of leftovers) {
    const rect = rectAt(e, dotBox, dotBox)
    if (blocked(rect, e) && !rank.has(e.id)) {
      modes.set(e.id, 'hidden')   // Tier 3 — never stack
      hidden++
    } else {
      placed.push(rect)
      modes.set(e.id, 'dot')
    }
  }

  return { modes, order: ordered.map(e => e.id), hidden }
}

/**
 * Repair pass — runs once the camera settles, against the *measured* DOM
 * instead of estimated rectangles. Rendered text metrics and marker
 * transforms can drift a few pixels from the model; this guarantees what
 * the broker actually sees never overlaps.
 *
 * @param order    priority sequence from computePlacements
 * @param get      (id) => { mode, rect() , setMode(mode) }
 * @param gap      minimum breathing room between rendered markers (px)
 * @returns number of markers demoted to hidden
 */
export function repairOverlaps(order, get, gap = 6, fixedRects = []) {
  const pad = (r) => ({
    x1: r.left - gap / 2, y1: r.top - gap / 2,
    x2: r.right + gap / 2, y2: r.bottom + gap / 2,
  })
  const accepted = fixedRects.map(pad)
  let hidden = 0

  for (const id of order) {
    const m = get(id)
    if (!m || m.mode === 'hidden') continue

    let box = pad(m.rect())
    if (accepted.some(a => intersects(box, a))) {
      if (m.mode === 'pill') {
        m.setMode('dot')                 // try the smaller footprint
        box = pad(m.rect())
        if (accepted.some(a => intersects(box, a))) {
          m.setMode('hidden'); hidden++; continue
        }
      } else {
        m.setMode('hidden'); hidden++; continue
      }
    }
    accepted.push(box)
  }
  return hidden
}
