import { projects } from '../data/projects.js'
import {
  buildClusterIndex, screenGroups, groupTarget, bubbleSize, FIT_MAX_ZOOM,
} from './clusters.js'

/* Web-mercator pixel maths at MapLibre's 512px tile size */
const TILE = 512
const toPx = (lng, lat, z) => {
  const size = TILE * 2 ** z
  const sin = Math.sin((lat * Math.PI) / 180)
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  }
}
const toLngLat = (x, y, z) => {
  const size = TILE * 2 ** z
  return {
    lng: (x / size) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI,
  }
}
const WORLD = [-180, -85, 180, 85]
const countOf = (g) => (g.kind === 'cluster' ? g.count : 1)
const groupsAt = (index, bbox, z) => screenGroups(index, bbox, z, (lng, lat) => toPx(lng, lat, z))

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`)
}

/* The same checks run on the full catalogue and on filtered subsets — a
   filter reshapes every cluster, so the guarantees must hold for any set. */
const sets = [
  ['all projects', projects],
  ['residential only', projects.filter(p => p.type !== 'Commercial')],
  ['under 5M EGP', projects.filter(p => p.priceValue < 5_000_000)],
  ['every 7th project', projects.filter((_, i) => i % 7 === 0)],
]

for (const [name, list] of sets) {
  const index = buildClusterIndex(list)
  const N = list.length
  console.log(`\n— ${name} (${N}) —`)

  /* 1. Every project is counted exactly once, at every zoom */
  {
    const bad = []
    for (let z = 3; z <= 17; z++) {
      const total = groupsAt(index, WORLD, z).reduce((s, g) => s + countOf(g), 0)
      if (total !== N) bad.push(`z${z}: ${total}/${N}`)
    }
    check(bad.length === 0, 'every project counted exactly once, zoom 3–17', bad.join(', '))
  }

  /* 2. No two bubbles ever touch */
  {
    let worst = 0
    const row = []
    for (let z = 4; z <= 16; z++) {
      const rects = groupsAt(index, WORLD, z).map(g => {
        const { x, y } = toPx(g.lng, g.lat, z)
        const { w, h } = g.kind === 'cluster' ? bubbleSize(g.count) : { w: 12, h: 12 }
        return { x1: x - w / 2, x2: x + w / 2, y1: y - h / 2, y2: y + h / 2 }
      })
      let pairs = 0
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j]
          if (a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1) pairs++
        }
      worst = Math.max(worst, pairs)
      row.push(`z${z}:${rects.length}`)
    }
    check(worst === 0, 'no two bubbles overlap, zoom 4–16', row.join(' '))
  }

  /* 3. Tapping a bubble frames exactly its projects, and it breaks apart */
  {
    const W = 900, H = 700, MARGIN = 40
    let tested = 0
    const bad = []
    for (const z of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      for (const g of groupsAt(index, WORLD, z).filter(x => x.kind === 'cluster')) {
        const t = groupTarget(index, g)
        tested++
        if (t.count !== g.count) { bad.push(`z${z} bubble ${g.count} has ${t.count} projects`); continue }

        const a = toPx(t.bounds[0][0], t.bounds[1][1], 0), b = toPx(t.bounds[1][0], t.bounds[0][1], 0)
        const dx = b.x - a.x, dy = b.y - a.y
        const fit = Math.min(dx ? Math.log2(W / dx) : Infinity, dy ? Math.log2(H / dy) : Infinity)
        const zoom = Math.min(Math.max(fit, t.splitZoom), FIT_MAX_ZOOM)
        const cx = ((a.x + b.x) / 2) * 2 ** zoom, cy = ((a.y + b.y) / 2) * 2 ** zoom
        const nw = toLngLat(cx - W / 2 - MARGIN, cy - H / 2 - MARGIN, zoom)
        const se = toLngLat(cx + W / 2 + MARGIN, cy + H / 2 + MARGIN, zoom)

        const mine = new Set(t.projectIds)
        const members = (x) => x.kind === 'point'
          ? [x.projectId]
          : [...x.points.map(p => p.projectId),
             ...x.clusterIds.flatMap(id => index.getLeaves(id, Infinity).map(l => l.properties.projectId))]
        const inside = groupsAt(index, [nw.lng, se.lat, se.lng, nw.lat], zoom)
          .filter(x => members(x).every(id => mine.has(id)))
        const shown = inside.reduce((s, x) => s + countOf(x), 0)

        if (shown !== g.count) bad.push(`z${z} bubble ${g.count} → ${shown} on screen`)
        else if (inside.length < 2 && zoom < FIT_MAX_ZOOM) bad.push(`z${z} bubble ${g.count} did not split`)
      }
    }
    check(bad.length === 0, `tap → the same projects fill the view and split apart (${tested} bubbles)`,
      bad.slice(0, 5).join('; '))
  }
}

/* 4. The selected project and compare picks never hide inside a bubble */
{
  const loose = [projects[0], projects[1], projects[500]]
  const looseIds = new Set(loose.map(p => p.id))
  const index = buildClusterIndex(projects, looseIds)
  const leaked = []
  let total = 0
  for (let z = 3; z <= 16; z++) {
    const groups = screenGroups(index, WORLD, z, (lng, lat) => toPx(lng, lat, z),
      loose.map(p => ({ projectId: p.id, lng: p.lng, lat: p.lat })))
    for (const g of groups) {
      const ids = g.kind === 'point'
        ? (g.loose ? [] : [g.projectId])
        : [...g.points.map(p => p.projectId),
           ...g.clusterIds.flatMap(id => index.getLeaves(id, Infinity).map(l => l.properties.projectId))]
      if (ids.some(id => looseIds.has(id))) leaked.push(`z${z}`)
    }
    if (z === 6) total = groups.reduce((s, g) => s + countOf(g), 0)
  }
  console.log('')
  check(leaked.length === 0 && total === projects.length,
    'selected / compare projects are drawn on their own, never inside a bubble',
    `leaks=${leaked.length} drawn=${total}/${projects.length}`)
}

console.log(failures === 0 ? '\nALL CLUSTER CHECKS PASS' : `\n${failures} CLUSTER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
