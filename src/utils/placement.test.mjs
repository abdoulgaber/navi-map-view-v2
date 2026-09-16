import { projects } from '../data/projects.js'
import {
  placeMarkers, repairOverlaps, estimatePillW, MIN_BUBBLE, PILL_H, DOT_SIZE,
} from './placement.js'
import { buildClusterIndex, screenGroups, groupMembers, bubbleSize } from './clusters.js'

/* Web-mercator pixel maths at MapLibre's 512px tile size */
const toPx = (lng, lat, z) => {
  const size = 512 * 2 ** z
  const sin = Math.sin((lat * Math.PI) / 180)
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size }
}
const toLngLat = (x, y, z) => {
  const size = 512 * 2 ** z
  return { lng: (x / size) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI }
}
const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
const shape = (x, y, w, h) => ({ x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 })

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`)
}

/* The map pipeline for one viewport: groups → names / dots / bubbles */
function layout(list, [clng, clat], z, { W = 920, H = 740, selected = null, obstacles = [] } = {}) {
  const byId = new Map(list.map(p => [p.id, p]))
  const rank = new Map(list.map((p, i) => [p.id, i]))
  const label = (id) => { const n = byId.get(id).name; return n.length > 20 ? `${n.slice(0, 19)}…` : n }

  const c = toPx(clng, clat, z)
  const view = (lng, lat) => { const p = toPx(lng, lat, z); return { x: p.x - c.x + W / 2, y: p.y - c.y + H / 2 } }
  const nw = toLngLat(c.x - W / 2, c.y - H / 2, z), se = toLngLat(c.x + W / 2, c.y + H / 2, z)
  const bbox = [nw.lng, se.lat, se.lng, nw.lat]

  const index = buildClusterIndex(list, new Set(selected ? [selected.id] : []))
  const loose = selected ? [{ projectId: selected.id, lng: selected.lng, lat: selected.lat }] : []
  const groups = screenGroups(index, bbox, z, view, loose).map(g => {
    const at = view(g.lng, g.lat)
    return {
      key: g.key, kind: g.kind, x: at.x, y: at.y,
      ...(g.kind === 'cluster' ? bubbleSize(g.count) : {}),
      members: groupMembers(index, g).map(m => ({ id: m.projectId, ...view(m.lng, m.lat) })),
    }
  })
  const result = placeMarkers(groups, {
    labelOf: label, rankOf: (id) => rank.get(id), priorityIds: selected ? [selected.id] : [], obstacles,
  })
  return { groups, label, ...result }
}

/* ── names stay clear of the interface floating over the map ─────────────── */
{
  const panel = { x1: 0, y1: 0, x2: 440, y2: 740 }       // the list panel
  const controls = { x1: 700, y1: 0, x2: 920, y2: 60 }   // the Map / Satellite switcher
  const cut = []
  let names = 0
  for (const z of [11, 12, 12.5, 13, 13.3, 14]) {
    const { groups, label, pins } = layout(projects.filter(p => p.type !== 'Commercial'), [31.47, 30.03], z,
      { obstacles: [panel, controls] })
    const pos = new Map(groups.flatMap(g => g.members.map(m => [m.id, m])))
    for (const [id, mode] of pins) {
      if (mode !== 'pill') continue
      names++
      const m = pos.get(id)
      const r = shape(m.x, m.y, estimatePillW(label(id)), PILL_H)
      if (overlaps(r, panel) || overlaps(r, controls)) cut.push(`z${z} ${label(id)}`)
    }
  }
  check(cut.length === 0, `no name pill sits under the panel or controls (${names} names checked)`, cut.slice(0, 5).join('; '))
}

/* ── names where they fit, numbers where they don't — on the real catalogue ── */
const residential = projects.filter(p => p.type !== 'Commercial')
const cheap = projects.filter(p => p.priceValue < 5_000_000)
const places = {
  'New Cairo': [31.47, 30.03], 'Heliopolis': [31.33, 30.07], 'Alexandria': [29.92, 31.2],
  'Sheikh Zayed': [30.95, 29.99], 'northern belt': [30.2, 30.5],
}

for (const [setName, list] of [['residential', residential], ['under 5M EGP', cheap]]) {
  const bad = []
  let cases = 0, bubbleCount = 0, small = 0, pills = 0, dots = 0
  for (const [place, center] of Object.entries(places)) {
    for (let z = 7; z <= 15; z++) {
      const { groups, label, bubbles, pins } = layout(list, center, z)
      cases++
      const where = `${place} z${z}`

      // every project in view is shown exactly once
      const inView = groups.flatMap(g => g.members.map(m => m.id))
      const shown = [...[...bubbles.values()].flat(), ...pins.keys()]
      if (shown.length !== inView.length || new Set(shown).size !== inView.length) {
        bad.push(`${where}: ${shown.length} shown / ${inView.length} in view`)
      }

      // no bubble holds a single project
      for (const ids of bubbles.values()) if (ids.length < MIN_BUBBLE) bad.push(`${where}: bubble of ${ids.length}`)

      // nothing drawn on top of anything else
      const pos = new Map(groups.flatMap(g => g.members.map(m => [m.id, m])))
      const drawn = [
        ...groups.filter(g => bubbles.has(g.key))
          .map(g => { const { w, h } = bubbleSize(bubbles.get(g.key).length); return shape(g.x, g.y, w, h) }),
        ...[...pins].map(([id, mode]) => {
          const m = pos.get(id)
          return mode === 'pill' ? shape(m.x, m.y, estimatePillW(label(id)), PILL_H) : shape(m.x, m.y, DOT_SIZE, DOT_SIZE)
        }),
      ]
      let pairs = 0
      for (let i = 0; i < drawn.length; i++)
        for (let j = i + 1; j < drawn.length; j++) if (overlaps(drawn[i], drawn[j])) pairs++
      if (pairs) bad.push(`${where}: ${pairs} overlapping markers`)

      bubbleCount += bubbles.size
      small += [...bubbles.values()].filter(ids => ids.length <= 3).length
      pills += [...pins.values()].filter(m => m === 'pill').length
      dots += [...pins.values()].filter(m => m === 'dot').length
    }
  }
  check(bad.length === 0,
    `${setName}: every project shown once, no single-project bubbles, no overlaps (${cases} views)`,
    bad.length ? bad.slice(0, 5).join('; ')
      : `names=${pills} bubbles=${bubbleCount} (of which ≤3: ${small}) dots=${dots}`)
}

/* ── the selected project always keeps its name ──────────────────────────── */
{
  const misses = []
  for (const [place, center] of Object.entries(places)) {
    const near = residential.find(p => Math.abs(p.lng - center[0]) < 0.05 && Math.abs(p.lat - center[1]) < 0.05)
    if (!near) continue
    for (const z of [8, 10, 12, 14]) {
      const { pins } = layout(residential, center, z, { selected: near })
      if (pins.get(near.id) !== 'pill') misses.push(`${place} z${z}: ${pins.get(near.id)}`)
    }
  }
  check(misses.length === 0, 'the selected project always keeps its name pill', misses.join('; '))
}

/* ── a stack of projects on one spot becomes one bubble, never a pile ────── */
{
  const stack = Array.from({ length: 40 }, (_, i) => ({ ...residential[0], id: 100000 + i, name: `Stacked ${i}` }))
  const { bubbles, pins } = layout(stack, [stack[0].lng, stack[0].lat], 16)
  const sizes = [...bubbles.values()].map(ids => ids.length)
  check(sizes.length === 1 && sizes[0] + pins.size === 40 && pins.size <= 1,
    'forty projects on one spot → one bubble', `bubbles=${JSON.stringify(sizes)} pins=${pins.size}`)
}

/* ── repair pass: model drift must be corrected against measured DOM ──── */
{
  let rng = 12345
  const rand = () => ((rng = (rng * 1664525 + 1013904223) & 0xffffffff) >>> 0) / 0xffffffff
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
        return { left: s.cx - w / 2, right: s.cx + w / 2, top: s.cy - h / 2, bottom: s.cy + h / 2 }
      },
      setMode: (m) => { s.mode = m },
    }
  }
  const countOverlaps = (list) => {
    let n = 0
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = get(list[i].id).rect(), b = get(list[j].id).rect()
      if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) n++
    }
    return n
  }
  const before = countOverlaps(sim)
  repairOverlaps(sim.map(s => s.id), get)
  const shown = sim.filter(s => s.mode !== 'hidden')
  const after = countOverlaps(shown)
  check(after === 0, 'repair pass on drifted DOM rects',
    `overlapsBefore=${before} overlapsAfter=${after} shown=${shown.length}/${sim.length}`)
}

console.log(failures === 0 ? '\nALL PLACEMENT CHECKS PASS' : `\n${failures} PLACEMENT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
