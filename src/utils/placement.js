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

export const MIN_BUBBLE = 2      // a bubble never holds a single project
export const STEP_OUT_MAX = 12   // names only step out of neighbourhood-sized bubbles —
                                 // a stray name beside "842" reads as noise, not information

/**
 * Names where they fit, numbers where they don't.
 *
 * Every group starts out holding its smallest footprint — a bubble for a
 * cluster, a dot for a lone project — so whatever is decided later, nothing
 * can ever land on top of anything else. Then, lone projects first and
 * smaller clusters next, projects step out of their group as full name
 * pills at their real positions whenever the pill clears everything:
 *
 *  - lone project → name pill, or its dot if the name can't breathe
 *  - cluster whose names all fit → opens up entirely into name pills
 *  - otherwise → the names that fit step out and the rest stay in the
 *    bubble, which always keeps at least MIN_BUBBLE projects
 *  - selected / compare projects always get their pill
 *
 * @param groups [{ key, kind: 'cluster'|'point', x, y, w, h, members: [{ id, x, y }] }]
 *               x/y/w/h = the bubble (clusters); members at their own positions
 * @param obstacles [{ x1, y1, x2, y2 }] interface chrome over the map (list
 *                  panel, controls) — a name is never tucked half under it
 * @returns { bubbles: Map<key, projectIds still inside>, pins: Map<projectId, 'pill'|'dot'> }
 */
export function placeMarkers(groups, { labelOf, priorityIds = [], rankOf = () => 0, obstacles = [] } = {}) {
  const box = (x, y, w, h, pad) => ({
    x1: x - w / 2 - pad / 2, y1: y - h / 2 - pad / 2,
    x2: x + w / 2 + pad / 2, y2: y + h / 2 + pad / 2,
  })
  const pillBox = (m) => box(m.x, m.y, estimatePillW(labelOf(m.id)), PILL_H, PILL_GAP)
  const dotBox  = (m) => box(m.x, m.y, DOT_SIZE, DOT_SIZE, DOT_GAP + HOVER_ROOM)

  const priority = new Map(priorityIds.map((id, i) => [id, i]))
  const priorityOf = (g) =>
    g.kind === 'point' && priority.has(g.members[0].id) ? priority.get(g.members[0].id) : Infinity
  const bestRank = (g) => Math.min(...g.members.map(m => rankOf(m.id)))

  // every group holds its smallest footprint until projects step out of it
  const reserved = new Map(groups.map(g => [
    g.key,
    g.kind === 'cluster' ? box(g.x, g.y, g.w, g.h, PILL_GAP) : dotBox(g.members[0]),
  ]))
  obstacles.forEach((o, i) => reserved.set(`chrome:${i}`, o))
  const placed = []
  const blocked = (p, ownKey) =>
    placed.some(q => intersects(p, q)) ||
    [...reserved].some(([key, r]) => key !== ownKey && intersects(p, r))

  const pins = new Map()
  const bubbles = new Map()

  const ordered = [...groups].sort((a, b) =>
    (priorityOf(a) - priorityOf(b)) ||
    (a.members.length - b.members.length) ||
    (bestRank(a) - bestRank(b)))

  for (const g of ordered) {
    if (g.kind === 'point') {
      const m = g.members[0]
      const pill = pillBox(m)
      if (priorityOf(g) !== Infinity || !blocked(pill, g.key)) {
        reserved.delete(g.key)
        placed.push(pill)
        pins.set(m.id, 'pill')
      } else {
        pins.set(m.id, 'dot')   // its reserved footprint is already clear
      }
      continue
    }

    const members = [...g.members].sort((a, b) => rankOf(a.id) - rankOf(b.id))
    if (members.length > STEP_OUT_MAX) {
      bubbles.set(g.key, members.map(m => m.id))
      continue
    }
    const pills = members.map(pillBox)

    // every name fits → the bubble opens up entirely
    const opens = pills.every((p, i) =>
      !blocked(p, g.key) && pills.every((q, j) => j === i || !intersects(p, q)))
    if (opens) {
      reserved.delete(g.key)
      placed.push(...pills)
      members.forEach(m => pins.set(m.id, 'pill'))
      continue
    }

    // otherwise the names that fit step out, clear of the bubble itself
    const own = reserved.get(g.key)
    const out = []
    members.forEach((m, i) => {
      const p = pills[i]
      if (intersects(p, own) || blocked(p, g.key) || out.some(o => intersects(p, o.p))) return
      out.push({ m, p })
    })
    while (members.length - out.length < MIN_BUBBLE && out.length) out.pop()

    out.forEach(({ m, p }) => { placed.push(p); pins.set(m.id, 'pill') })
    const stepped = new Set(out.map(o => o.m.id))
    bubbles.set(g.key, members.filter(m => !stepped.has(m.id)).map(m => m.id))
  }

  /* Second chance for lone dots: a bubble that opened up may have freed the
     room for their name; failing that, a dot squeezed against a bubble joins
     it — as long as the count keeps the bubble's width. Only a project boxed
     in by other names stays a dot. */
  const byKey = new Map(groups.map(g => [g.key, g]))
  for (const [id, mode] of [...pins]) {
    if (mode !== 'dot') continue
    const g = groups.find(x => x.kind === 'point' && x.members[0].id === id)
    const pill = pillBox(g.members[0])
    if (!blocked(pill, g.key)) {
      reserved.delete(g.key)
      placed.push(pill)
      pins.set(id, 'pill')
      continue
    }
    const host = [...bubbles.keys()].find(key => {
      const r = reserved.get(key)
      const ids = bubbles.get(key)
      return r && intersects(pill, r) &&
        String(ids.length + 1).length <= String(byKey.get(key).members.length).length
    })
    if (host) {
      bubbles.get(host).push(id)
      pins.delete(id)
      reserved.delete(g.key)
    }
  }

  return { bubbles, pins }
}

/**
 * Repair pass — runs once the camera settles, against the *measured* DOM
 * instead of estimated rectangles. Rendered text metrics and marker
 * transforms can drift a few pixels from the model; this guarantees what
 * the broker actually sees never overlaps.
 *
 * @param order    ids in priority order (best first)
 * @param get      (id) => { mode, rect() , setMode(mode) }
 * @param gap      minimum breathing room between rendered markers (px)
 * @param canHide  false → a pin is never removed, only shrunk to a dot
 *                 (the map relies on every project staying visible)
 * @returns number of markers changed
 */
export function repairOverlaps(order, get, gap = 6, fixedRects = [], { canHide = true } = {}) {
  const pad = (r) => ({
    x1: r.left - gap / 2, y1: r.top - gap / 2,
    x2: r.right + gap / 2, y2: r.bottom + gap / 2,
  })
  const accepted = fixedRects.map(pad)
  let changed = 0

  for (const id of order) {
    const m = get(id)
    if (!m || m.mode === 'hidden') continue

    let box = pad(m.rect())
    if (accepted.some(a => intersects(box, a))) {
      if (m.mode === 'pill') {
        m.setMode('dot')                 // try the smaller footprint
        changed++
        box = pad(m.rect())
      }
      if (canHide && accepted.some(a => intersects(box, a))) {
        m.setMode('hidden'); changed++; continue
      }
    }
    accepted.push(box)
  }
  return changed
}
