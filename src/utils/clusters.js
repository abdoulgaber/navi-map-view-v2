import Supercluster from 'supercluster'

/**
 * Number clusters.
 *
 * Projects are grouped purely by how close they sit on screen at the
 * current zoom — no area names, no borders. A cluster shows how many
 * projects it holds; tapping it frames exactly those projects, where it
 * breaks apart into smaller clusters and, eventually, single projects.
 *
 * Pure functions over plain data, so the behaviour is unit tested without
 * a map instance (see clusters.test.mjs).
 */

export const CLUSTER_MAX_ZOOM = 15   // past this every project stands alone
export const FIT_MAX_ZOOM     = 16

/**
 * Grouping radius per zoom level (px). Zoomed out, a tighter radius keeps
 * the country view readable — a handful of city-sized bubbles rather than
 * one blob. Zoomed in, a wide radius turns what would be a field of 2s and
 * 3s into a few meaningful bubbles; wherever a name fits, projects step out
 * of their bubble anyway (placeMarkers in placement.js). Tuned on the real
 * catalogue — see clusters.test.mjs / placement.test.mjs.
 */
export const CLUSTER_RADIUS = 140   // the widest radius used at any zoom
export const radiusAt = (zoom) =>
  zoom <= 8 ? 72 : zoom === 9 ? 90 : zoom === 10 ? 110 : CLUSTER_RADIUS

/* Supercluster reads `options.radius` once per zoom level while it builds
   the hierarchy; swapping it in for that level gives a zoom-aware radius.
   The base option stays at the widest value because getChildren/getLeaves
   search with it — a wider search still finds every child. */
class ZoomAwareSupercluster extends Supercluster {
  _cluster(data, numItems, zoom, out) {
    const widest = this.options.radius
    this.options.radius = radiusAt(zoom)
    try {
      return super._cluster(data, numItems, zoom, out)
    } finally {
      this.options.radius = widest
    }
  }
}

const GAP      = 6    // minimum room between two rendered bubbles (px)
const DOT_SIZE = 12   // a single project's smallest footprint (see .dot-pin)

/** Rendered size of a bubble — mirrors .cluster-pin in index.css */
export const bubbleSize = (count) => ({
  w: Math.max(26, String(count).length * 7.2 + 14) + 12,
  h: 38,
})

/**
 * @param projects  the filtered project list
 * @param looseIds  projects that must never hide inside a cluster
 *                  (the selected one, compare picks)
 */
export function buildClusterIndex(projects, looseIds = new Set()) {
  const index = new ZoomAwareSupercluster({ radius: CLUSTER_RADIUS, maxZoom: CLUSTER_MAX_ZOOM })
  index.load(
    projects
      .filter(p => !looseIds.has(p.id))
      .map(p => ({
        type: 'Feature',
        properties: { projectId: p.id },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
  )
  return index
}

const intersects = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1

const footprint = (g, { x, y }) => {
  const { w, h } = g.kind === 'cluster' ? bubbleSize(g.count) : { w: DOT_SIZE, h: DOT_SIZE }
  return { x1: x - w / 2 - GAP / 2, y1: y - h / 2 - GAP / 2, x2: x + w / 2 + GAP / 2, y2: y + h / 2 + GAP / 2 }
}

/**
 * What to draw inside a bbox at a zoom level.
 *
 * Supercluster's own grouping changes only at whole zoom levels, which
 * keeps bubbles stable while the broker zooms. Its cluster centres can
 * drift close to a neighbour though, so a screen pass folds anything that
 * would still touch into the bigger bubble — counts add up, nothing is
 * ever stacked or silently dropped.
 *
 * @param toScreen (lng, lat) => { x, y }
 * @param loose    [{ projectId, lng, lat }] always drawn on their own
 * @returns [{ kind: 'cluster', key, count, lng, lat, clusterIds, points }
 *          | { kind: 'point', key, projectId, lng, lat, loose? }]
 */
export function screenGroups(index, bbox, zoom, toScreen, loose = []) {
  const raw = index.getClusters(bbox, Math.floor(zoom)).map(f => {
    const [lng, lat] = f.geometry.coordinates
    return f.properties.cluster
      ? { kind: 'cluster', count: f.properties.point_count, lng, lat,
          clusterIds: [f.properties.cluster_id], points: [] }
      : { kind: 'point', projectId: f.properties.projectId, lng, lat }
  })

  // biggest first, so small neighbours fold into the landmark bubble
  raw.sort((a, b) => (b.kind === 'cluster' ? b.count : 0) - (a.kind === 'cluster' ? a.count : 0))

  const fixed = loose.map(p => ({ kind: 'point', loose: true, ...p }))
  let groups = []
  for (const item of raw) {
    const at = toScreen(item.lng, item.lat)
    const box = footprint(item, at)
    const host = groups.find(g => intersects(box, g.box))
    if (!host) { groups.push({ ...item, at, box }); continue }
    absorb(host, item)
  }

  // a bubble that grew by a digit can now touch a neighbour — settle it
  for (let pass = 0; pass < 4; pass++) {
    let merged = false
    const next = []
    for (const g of groups) {
      const host = next.find(n => intersects(g.box, n.box))
      if (host) { absorb(host, g); merged = true } else next.push(g)
    }
    groups = next
    if (!merged) break
  }

  return [...groups, ...fixed].map(g => ({ ...g, key: keyOf(g), box: undefined, at: undefined }))
}

/* Fold `item` into `host`, turning a lone project into a cluster if needed */
function absorb(host, item) {
  if (host.kind === 'point') {
    host.points = [{ projectId: host.projectId, lng: host.lng, lat: host.lat }]
    host.clusterIds = []
    host.count = 1
    host.kind = 'cluster'
    delete host.projectId
  }
  if (item.kind === 'cluster') {
    host.count += item.count
    host.clusterIds.push(...item.clusterIds)
    host.points.push(...item.points)
  } else {
    host.count += 1
    host.points.push({ projectId: item.projectId, lng: item.lng, lat: item.lat })
  }
  const { x, y } = host.at
  host.box = footprint(host, { x, y })
}

const keyOf = (g) => g.kind === 'point'
  ? `p:${g.projectId}`
  : `c:${[...g.clusterIds].sort((a, b) => a - b).join('+')}|${g.points.map(p => p.projectId).sort((a, b) => a - b).join('+')}`

/** Every project inside a group, with its own position */
export function groupMembers(index, group) {
  if (group.kind === 'point') return [{ projectId: group.projectId, lng: group.lng, lat: group.lat }]
  const members = group.points.map(p => ({ ...p }))
  for (const id of group.clusterIds) {
    let leaves
    try { leaves = index.getLeaves(id, Infinity) } catch { continue }
    for (const leaf of leaves) {
      const [lng, lat] = leaf.geometry.coordinates
      members.push({ projectId: leaf.properties.projectId, lng, lat })
    }
  }
  return members
}

/**
 * Where a tap on a group should take the camera: the bounds of exactly its
 * projects, plus `splitZoom` — the least zoom that breaks it apart.
 *
 * Only a single Supercluster cluster needs that floor (its leaves could
 * otherwise still share one bubble). A bubble the screen pass folded
 * together is already several groups, so fitting its bounds splits it —
 * forcing the floor there would push some of its projects off screen.
 */
export function groupTarget(index, group) {
  const members = groupMembers(index, group)
  if (!members.length) return null
  return {
    bounds: boundsOf(members),
    count: members.length,
    projectIds: members.map(m => m.projectId),
    splitZoom: splitZoomOf(index, group),
  }
}

/** The zoom a tap must reach for this group to break apart (0 = just fit it) */
export function splitZoomOf(index, group) {
  const single = group.kind === 'cluster' && group.clusterIds.length === 1 && group.points.length === 0
  return single ? index.getClusterExpansionZoom(group.clusterIds[0]) : 0
}

/** [[w, s], [e, n]] around [{ lng, lat }] */
export function boundsOf(members) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const { lng, lat } of members) {
    if (lng < w) w = lng
    if (lng > e) e = lng
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return [[w, s], [e, n]]
}
