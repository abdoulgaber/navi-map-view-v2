import {
  computePlacements, repairOverlaps, estimatePillW,
  PILL_H, DOT_SIZE,
} from './placement.js'

/* Rendered geometry (no breathing margin) — what the user actually sees */
const renderedRect = (e, mode) => {
  const w = mode === 'pill' ? estimatePillW(e.label) : DOT_SIZE
  const h = mode === 'pill' ? PILL_H : DOT_SIZE
  return { x1: e.x - w / 2, y1: e.y - h / 2, x2: e.x + w / 2, y2: e.y + h / 2 }
}
const overlap = (a, b) => {
  const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  return ox > 0 && oy > 0 ? Math.min(ox, oy) : 0
}

let rng = 12345
const rand = () => ((rng = (rng * 1664525 + 1013904223) & 0xffffffff) >>> 0) / 0xffffffff

function makeScenario(name, count, spread) {
  const entries = []
  for (let i = 0; i < count; i++) {
    entries.push({
      id: i,
      x: 400 + (rand() - 0.5) * spread,
      y: 400 + (rand() - 0.5) * spread,
      label: `EGP ${(rand() * 25 + 1).toFixed(1)}M`,
    })
  }
  return { name, entries }
}

const scenarios = [
  makeScenario('country zoom (very dense, 500 pins in 300px)', 500, 300),
  makeScenario('city zoom (200 pins in 900px)', 200, 900),
  makeScenario('street zoom (40 pins spread over 1600px)', 40, 1600),
  makeScenario('pathological (100 pins on identical point)', 100, 0),
]

/* two cluster bubbles every pin has to leave alone */
const bubbles = [{ x: 380, y: 390, w: 48, h: 38 }, { x: 620, y: 300, w: 40, h: 38 }]
const bubbleRect = (b) => ({ x1: b.x - b.w / 2, y1: b.y - b.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 })

let failures = 0
for (const { name, entries } of scenarios) {
  const selectedId = entries[5]?.id ?? null
  const { modes, hidden } = computePlacements(entries, { priorityIds: [selectedId], fixed: bubbles })

  const shown = entries
    .map(e => ({ e, mode: modes.get(e.id) }))
    .filter(x => x.mode !== 'hidden')

  let worst = 0, pairs = 0
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const o = overlap(renderedRect(shown[i].e, shown[i].mode), renderedRect(shown[j].e, shown[j].mode))
      if (o > 0) { pairs++; worst = Math.max(worst, o) }
    }

  // pins covering a bubble (the selected project is allowed to)
  const onBubble = shown.filter(s => s.e.id !== selectedId &&
    bubbles.some(b => overlap(renderedRect(s.e, s.mode), bubbleRect(b)) > 0)).length

  const pills = shown.filter(s => s.mode === 'pill')
  const dots  = shown.filter(s => s.mode === 'dot')
  const selectedShown = modes.get(selectedId) !== 'hidden'

  const ok = pairs === 0 && onBubble === 0 && selectedShown
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n` +
    `      pills=${pills.length} dots=${dots.length} hidden=${hidden} ` +
    `overlappingPairs=${pairs} worstOverlapPx=${worst.toFixed(1)} pinsOnBubbles=${onBubble}\n` +
    `      selected=${modes.get(selectedId)}`
  )
}

/* ── repair pass: model drift must be corrected against measured DOM ──── */
{
  // Simulate rendered rects that drift up to ±14px from the model, which is
  // what produced real overlaps on the deployed build.
  const drift = () => (rand() - 0.5) * 28
  const sim = []
  for (let i = 0; i < 60; i++) {
    const cx = 400 + (rand() - 0.5) * 700, cy = 400 + (rand() - 0.5) * 700
    sim.push({ id: i, cx, cy, mode: 'pill', w: 82 + drift(), h: PILL_H })
  }
  const state = new Map(sim.map(s => [s.id, s]))
  const get = (id) => {
    const s = state.get(id)
    if (!s) return null
    return {
      get mode() { return s.mode },
      rect: () => {
        const w = s.mode === 'pill' ? s.w : DOT_SIZE
        const h = s.mode === 'pill' ? s.h : DOT_SIZE
        return { left: s.cx - w/2, right: s.cx + w/2, top: s.cy - h/2, bottom: s.cy + h/2 }
      },
      setMode: (m) => { s.mode = m },
    }
  }
  const order = sim.map(s => s.id)
  const before = (() => {
    let n = 0
    for (let i = 0; i < sim.length; i++) for (let j = i+1; j < sim.length; j++) {
      const a = get(sim[i].id).rect(), b = get(sim[j].id).rect()
      if (Math.min(a.right,b.right) > Math.max(a.left,b.left) && Math.min(a.bottom,b.bottom) > Math.max(a.top,b.top)) n++
    }
    return n
  })()

  repairOverlaps(order, get)

  const shown = sim.filter(s => s.mode !== 'hidden')
  let after = 0
  for (let i = 0; i < shown.length; i++) for (let j = i+1; j < shown.length; j++) {
    const a = get(shown[i].id).rect(), b = get(shown[j].id).rect()
    if (Math.min(a.right,b.right) > Math.max(a.left,b.left) && Math.min(a.bottom,b.bottom) > Math.max(a.top,b.top)) after++
  }
  const ok = after === 0
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  repair pass on drifted DOM rects\n` +
    `      overlapsBefore=${before} overlapsAfter=${after} ` +
    `shown=${shown.length}/${sim.length}`
  )
}


console.log(failures === 0 ? '\nALL SCENARIOS PASS — zero overlaps at every density' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
