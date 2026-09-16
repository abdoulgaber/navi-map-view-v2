import { useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapGL, Marker, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre v6 resolves its worker at runtime via a template literal
// (`new URL(\`./${name}\`, import.meta.url)`), which bundlers cannot see —
// so the worker is never emitted and 404s in production, leaving a blank
// map (no vector tiles, no GeoJSON). Hand it the URL Vite actually built.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { placeMarkers, repairOverlaps } from '../utils/placement.js'
import {
  buildClusterIndex, screenGroups, groupMembers, splitZoomOf, boundsOf, bubbleSize, FIT_MAX_ZOOM,
} from '../utils/clusters.js'

/**
 * MapCanvas — MapLibre GL map with:
 *  - Globe intro flying into Egypt on first load
 *  - Number clusters: nearby projects share one bubble showing how many
 *    they are; tapping it frames exactly those projects, where it splits
 *    into smaller bubbles and, eventually, single projects
 *  - Single projects as name pills, placed by screen-space collision;
 *    pins that don't fit render as small dots and promote back on zoom-in
 *  - Hover card per pin/dot, Map/Satellite toggle, compare highlighting
 */

setWorkerUrl(maplibreWorkerUrl)

const MAP_STYLE  = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
const SAT_STYLE = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Tiles © Esri',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
}
/* The market lives in the northern belt — North Coast ⇢ Delta ⇢ Greater
   Cairo ⇢ New Capital / Ain Sokhna. The intro lands there rather than on
   the whole country, most of which is empty desert. */
const NORTH_EGYPT_BOUNDS = [[27.6, 29.25], [32.75, 31.75]]  // [[w,s],[e,n]]
const NORTH_EGYPT_VIEW   = { center: [30.2, 30.5], zoom: 6.9 } // instant fallback
const GLOBE_VIEW  = { center: [8, 15], zoom: 1.4 }
const INTRO_MS    = 3200
const MARGIN      = 80   // px past the viewport edge that markers are kept for

/* The floating list panel covers the left edge — nudge camera targets into
   the visible half of the map. NOTE: use `offset` (screen px), never
   `padding`: camera padding under globe projection yields a broken
   transform, which freezes the camera and leaves the map unpainted. */
const PANEL_OFFSET = [224, 0]

/* width of the project drawer (see .pdrawer) — used to centre a selected
   project in the gap that is left between the panel and the drawer */
const DRAWER_W = 560

/* Fit padding — whatever chrome covers the map on this layout. Desktop and
   tablet lose their left edge to the panel; phones lose the bottom to the
   sheet. Values are clamped so a fit can never exceed the viewport. */
const FIT_PADDING = { left: 460, top: 80, right: 60, bottom: 90 }

const shortPrice = (v) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(v % 1_000_000 >= 100_000 ? 1 : 0)}M`
    : `${Math.round(v / 1_000)}K`

/* Chips carry the project NAME — brokers recognise projects by name, and
   the exact price is one hover away on the quick-view card. Long names are
   clipped so a single chip can never hog the viewport. */
const MAX_LABEL = 20
const pinLabel = (p) =>
  p.name.length > MAX_LABEL ? `${p.name.slice(0, MAX_LABEL - 1).trimEnd()}…` : p.name

/* Photo pool for the hover card — deterministic per project so a chip
   always previews the same image. */
const PHOTOS = [
  'https://images.unsplash.com/photo-1613977257363-707ba9348227?auto=format&fit=crop&w=720&q=70',
  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=720&q=70',
  'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=720&q=70',
  'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=720&q=70',
]

const BADGE_STYLE = {
  Trendy:    { bg: '#EF476F', icon: '🔥' },
  Incentive: { bg: '#FF6006', icon: '💰' },
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
))

const hoverCardHTML = (p) => {
  const badges = p.badges.map(b => {
    const cfg = BADGE_STYLE[b]
    return `<span class="pin-card-badge" style="background:${cfg.bg}">${cfg.icon} ${b}</span>`
  }).join('')
  return `
  <article class="pin-card">
    <div class="pin-card-media" style="background-image:url('${PHOTOS[p.id % PHOTOS.length]}')">
      <div class="pin-card-badges">${badges}</div>
    </div>
    <div class="pin-card-body">
      <div class="pin-card-head">
        <span class="pin-card-logo">${escapeHTML(p.developer.slice(0, 2).toUpperCase())}</span>
        <span class="pin-card-dev">${escapeHTML(p.developer)}</span>
      </div>
      <h4 class="pin-card-name">${escapeHTML(p.name)}</h4>
      <p class="pin-card-price">Starting ${escapeHTML(p.price)}</p>
    </div>
  </article>`
}

/* Mercator midpoint of a latitude span — what the map treats as "centre" */
const midLat = (s, n) => {
  const y = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return (Math.atan(Math.exp((y(s) + y(n)) / 2)) * 360) / Math.PI - 90
}

export default function MapCanvas({
  projects,
  selectedProject,
  onSelectProject,
  compareSelection,
  compareFocus = null,   // { id, seq } — a compare pick made from the list
  layout = 'desktop',
  children,
}) {
  const containerRef  = useRef(null)
  const mapRef        = useRef(null)
  const clusterMarkers = useRef(new Map())  // group key → { marker, el, group }
  const pinMarkers     = useRef(new Map())  // project.id → { marker, el, mode }
  const hoverCardRef  = useRef(null)
  const lookupRef     = useRef({ byId: new Map(), rank: new Map() })
  const clusterIndexRef = useRef(null)
  const selectedRef   = useRef(null)
  const compareRef    = useRef(compareSelection)
  const compareFocusRef = useRef(null)
  const callbacksRef  = useRef({ onSelectProject })
  const watchdogRef     = useRef(null)
  const introDoneRef    = useRef(false)
  const cameraIntentRef = useRef(null)   // last camera we asked for
  const hadSizeRef      = useRef(false)
  const movingRef       = useRef(false)   // true between movestart and moveend
  const layoutRef       = useRef(layout)
  layoutRef.current     = layout

  /* MapLibre silently ignores camera commands while its container has no
     size (hidden tab, collapsed panel, a pane that opens at 0×0). Remember
     what we last asked for so it can be applied the moment size arrives —
     otherwise the map stays frozen on its initial view forever. */
  const setCamera = (map, intent) => {
    const { clientWidth: w, clientHeight: h } = map.getContainer()
    if (!w || !h) {
      // dropped: no viewport to animate into — recovery replays it later
      cameraIntentRef.current = { ...intent, applied: false }
      return
    }
    cameraIntentRef.current = { ...intent, applied: true }
    if (intent.kind === 'fit') map.fitBounds(intent.bounds, intent.opts)
    else                      map.flyTo(intent.opts)
  }


  /* ── Hover card ───────────────────────────────────────────────────────
     Anchored to the CHIP and clamped to the usable interface area: it
     flips above/below and slides sideways so it can never fall off the
     viewport or hide behind the floating list panel.                     */
  const HOVER_GAP    = 12
  const HOVER_MARGIN = 12

  const usableArea = () => {
    const panel = document.querySelector('.list-panel')?.getBoundingClientRect()
    const map   = containerRef.current?.getBoundingClientRect()
    return {
      left:   Math.max(panel ? panel.right + HOVER_GAP : 0, map?.left ?? 0) + HOVER_MARGIN,
      top:    (map?.top ?? 0) + HOVER_MARGIN,
      right:  (map?.right ?? window.innerWidth) - HOVER_MARGIN,
      bottom: (map?.bottom ?? window.innerHeight) - HOVER_MARGIN,
    }
  }

  const showHoverCard = (project, anchorEl) => {
    let card = hoverCardRef.current
    if (!card) {
      card = document.createElement('div')
      card.className = 'pin-hover-card'
      document.body.appendChild(card)
      hoverCardRef.current = card
    }
    card.innerHTML = hoverCardHTML(project)
    card.style.visibility = 'hidden'
    card.style.display    = 'block'

    const c    = card.getBoundingClientRect()
    const a    = anchorEl.getBoundingClientRect()
    const area = usableArea()

    // prefer above the chip, fall back to below, then clamp inside
    let top = a.top - c.height - HOVER_GAP
    if (top < area.top) top = a.bottom + HOVER_GAP
    top = Math.min(Math.max(top, area.top), Math.max(area.top, area.bottom - c.height))

    let left = a.left + a.width / 2 - c.width / 2      // centred on the chip
    left = Math.min(Math.max(left, area.left), Math.max(area.left, area.right - c.width))

    card.style.left = `${Math.round(left)}px`
    card.style.top  = `${Math.round(top)}px`
    card.style.visibility = 'visible'
  }

  const hideHoverCard = () => {
    const card = hoverCardRef.current
    if (card) card.style.display = 'none'
  }


  /* Where a selected project should sit: dead centre of the strip the
     broker can actually see — between the list panel and the detail
     drawer — never tucked behind either of them. */
  const focusOffset = (drawerOpen) => {
    const map = mapRef.current
    if (!map) return [0, 0]
    const el = map.getContainer()
    const { clientWidth: W, clientHeight: H } = el
    const box = el.getBoundingClientRect()

    /* Phones stack their chrome: the sheet/drawer covers the BOTTOM, so the
       free strip runs vertically. Wider layouts put panel and drawer on the
       sides, so the free strip runs horizontally. */
    if (layoutRef.current === 'mobile') {
      const sheet = document.querySelector('.list-panel, .pdrawer')?.getBoundingClientRect()
      const bottom = sheet ? Math.max(sheet.top - box.top, H * 0.35) : H
      return [0, Math.round((bottom / 2) - H / 2)]
    }

    const panel = document.querySelector('.list-panel')?.getBoundingClientRect()
    const left  = panel ? panel.right - box.left + 12 : 12
    const right = drawerOpen && layoutRef.current === 'desktop'
      ? W - (DRAWER_W + 16 + 12)
      : W - 12
    return [Math.round((left + right) / 2 - W / 2), 0]
  }


  /* Padding for fitBounds: keep the fitted area inside the strip this
     layout actually leaves visible, and never let it exceed the map. */
  const fitPadding = () => {
    const map = mapRef.current
    if (!map) return { top: 24, right: 24, bottom: 24, left: 24 }
    const { clientWidth: W, clientHeight: H } = map.getContainer()
    // top clears the Compare / Map-Satellite row so no bubble lands under it
    const raw = layoutRef.current === 'mobile'
      ? { top: 72, right: 24, bottom: Math.round(H * 0.42), left: 24 }
      : layoutRef.current === 'tablet'
        ? { top: 76, right: 40, bottom: 70, left: 360 }
        : FIT_PADDING
    return {
      top:    Math.min(raw.top,    Math.max(0, H / 2 - 40)),
      bottom: Math.min(raw.bottom, Math.max(0, H / 2 - 40)),
      left:   Math.min(raw.left,   Math.max(0, W / 2 - 40)),
      right:  Math.min(raw.right,  Math.max(0, W / 2 - 40)),
    }
  }

  /* The intro watchdog rescues a stalled globe, but it must never fight the
     broker: a finished intro — or any navigation they trigger — retires it. */
  const disarmWatchdog = () => {
    introDoneRef.current = true
    clearTimeout(watchdogRef.current)
  }

  const [mapReady, setMapReady]       = useState(false)
  const [introDone, setIntroDone]     = useState(false)
  const [mapType, setMapType]         = useState('map')

  lookupRef.current = useMemo(() => ({
    byId: new Map(projects.map(p => [p.id, p])),
    rank: new Map(projects.map((p, i) => [p.id, i])),   // list order
  }), [projects])

  /* Clusters are rebuilt whenever the project set changes — and whenever a
     project is selected or picked for compare: those are always drawn on
     their own, never folded into a bubble. */
  const looseKey = [selectedProject?.id, ...(compareSelection ?? [])].join(',')
  const clusterIndex = useMemo(() => {
    const loose = new Set([selectedProject?.id, ...(compareSelection ?? [])].filter(id => id != null))
    return buildClusterIndex(projects, loose)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, looseKey])
  clusterIndexRef.current = clusterIndex

  selectedRef.current  = selectedProject
  compareRef.current   = compareSelection
  callbacksRef.current   = { onSelectProject }

  /* ── init map once ─────────────────────────────────────────────────── */
  useEffect(() => {
    const map = new MapGL({
      container: containerRef.current,
      style: MAP_STYLE,
      center: GLOBE_VIEW.center,
      zoom: GLOBE_VIEW.zoom,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    // Support handles: inspect layers/camera and the pending camera intent
    // on a live deployment when diagnosing a stuck view.
    if (typeof window !== 'undefined') {
      window.__naviMap = map
      window.__naviDebug = {
        intent:  () => cameraIntentRef.current,
        hadSize: () => hadSizeRef.current,
        markers: () => ({
          bubbles: [...clusterMarkers.current.values()].map(e => ({
            count: e.group.count, lng: e.group.lng, lat: e.group.lat,
          })),
          pins: [...pinMarkers.current.entries()].map(([id, e]) => ({ id, mode: e.mode })),
        }),
      }
    }

    /* Markers/layers only need the STYLE, not every tile — gating on 'load'
       would leave the map empty whenever tiles are slow to arrive. */
    let started = false
    const start = () => {
      if (started) return
      started = true
      setMapReady(true)
      setTimeout(() => {
        /* Frame the northern belt for THIS viewport, but fly with a plain
           center/zoom: camera padding under globe projection corrupts the
           transform, so we resolve the padded framing up front instead. */
        let target = NORTH_EGYPT_VIEW
        try {
          const cam = map.cameraForBounds(NORTH_EGYPT_BOUNDS, { padding: fitPadding() })
          if (cam) target = { center: cam.center, zoom: Math.min(cam.zoom, 8) }
        } catch { /* keep the fallback framing */ }
        setCamera(map, {
          kind: 'fly',
          opts: { ...target, duration: INTRO_MS, curve: 1.32, essential: true },
        })
        map.once('moveend', () => {
          /* Globe is only for the cinematic entry. Everything after it —
             tiles, bubbles, hours of broker panning — runs on mercator,
             which is the widely-supported path on every GPU/driver. */
          try { map.setProjection({ type: 'mercator' }) } catch { /* ignore */ }
          disarmWatchdog()
          setIntroDone(true)
          syncLayers()
        })
        // never leave the UI chrome hidden — or the map stuck on globe —
        // if the camera event is missed
        setTimeout(() => {
          try { map.setProjection({ type: 'mercator' }) } catch { /* ignore */ }
          disarmWatchdog()
          setIntroDone(true)
          syncLayers()
        }, INTRO_MS + 1500)
      }, 400)

      /* Watchdog — if the camera never reaches Egypt (globe transform can
         stall on some GPUs/drivers), drop to mercator and show Egypt
         directly rather than leaving the broker on a blank sphere.
         It must never fight the broker: any completed intro or user
         navigation disarms it (see disarmWatchdog). */
      watchdogRef.current = setTimeout(() => {
        if (!mapRef.current || introDoneRef.current) return
        if (map.getZoom() < GLOBE_VIEW.zoom + 1.5) {
          try { map.setProjection({ type: 'mercator' }) } catch { /* ignore */ }
          map.jumpTo({ ...NORTH_EGYPT_VIEW })
          setIntroDone(true)
          syncLayers()
        }
      }, INTRO_MS + 2600)
    }

    map.on('style.load', () => {
      try { map.setProjection({ type: 'globe' }) } catch { /* raster fallback */ }
      start()
    })
    map.on('load', start)
    const startFallback = setTimeout(start, 5000)

    /* Markers ride along with the camera on their own; bubbles and pills
       are re-decided once it settles (see syncLayers). */
    map.on('movestart', () => { movingRef.current = true; hideHoverCard() })
    map.on('moveend', () => { movingRef.current = false; syncLayers(); repairPass() })
    /* 'idle' is the only signal that the camera has settled AND every
       marker has been positioned — decluttering before that measures
       stale positions and can hide labels that do not actually collide. */
    map.on('idle', () => { syncLayers(); repairPass() })

    /* Recover from a zero-sized container. MapLibre drops camera commands
       while it has no box, so the intro (or an area fit) can be lost; when
       size finally arrives we replay it. ResizeObserver is the primary
       signal, but some embedded/backgrounded views throttle it, so the
       map's own resize event and a bounded poll cover that case too. */
    const recoverCamera = () => {
      const { clientWidth: w, clientHeight: h } = map.getContainer()
      if (!w || !h) { hadSizeRef.current = false; return false }
      if (hadSizeRef.current) return true
      hadSizeRef.current = true
      try { map.resize() } catch { /* keep going — the replay matters more */ }

      /* Replay ONLY a camera move that never ran for want of a viewport.
         On a healthy load the intro flight is already playing and must not
         be cut short — that would kill the opening animation. */
      const intent = cameraIntentRef.current
      if (intent && intent.applied === false) {
        const opts = { ...intent.opts, duration: 0 }
        if (intent.kind === 'fit') map.fitBounds(intent.bounds, opts)
        else                       map.flyTo(opts)
        cameraIntentRef.current = { ...intent, applied: true }
        disarmWatchdog()
        setIntroDone(true)
        syncLayers()
      }
      return true
    }

    const ro = new ResizeObserver(() => recoverCamera())
    ro.observe(containerRef.current)
    map.on('resize', recoverCamera)
    const sizePoll = setInterval(() => { if (recoverCamera()) clearInterval(sizePoll) }, 800)
    const sizePollStop = setTimeout(() => clearInterval(sizePoll), 30000)

    return () => {
      hoverCardRef.current?.remove()
      hoverCardRef.current = null
      clearInterval(sizePoll)
      clearTimeout(sizePollStop)
      ro.disconnect()
      clearTimeout(startFallback)
      clearTimeout(watchdogRef.current)
      clearTimeout(repairTimer.current)
      hideHoverCard()
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Map / Satellite style switch ──────────────────────────────────── */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    map.setStyle(mapType === 'sat' ? SAT_STYLE : MAP_STYLE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapType])

  /* ── what to draw: number bubbles first, then name pills / dots ────── */
  const clearMarkers = () => {
    clusterMarkers.current.forEach(entry => entry.marker.remove())
    clusterMarkers.current.clear()
    pinMarkers.current.forEach(entry => entry.marker.remove())
    pinMarkers.current.clear()
  }

  const syncLayers = () => {
    const map = mapRef.current
    const index = clusterIndexRef.current
    if (!map || !index) return

    /* Nothing over the opening flight: markers appear once the intro is
       done AND the camera has left globe scale. */
    const landed = introDoneRef.current && map.getZoom() > GLOBE_VIEW.zoom + 1.5
    if (!landed) {
      clearMarkers()
      hideHoverCard()
      return
    }

    /* Markers already travel with the camera. Re-grouping on every frame
       of a pinch or pan is what makes a map flicker, so bubbles and pills
       are only re-decided once the camera settles (moveend / idle). */
    if (movingRef.current) return

    const { clientWidth: W, clientHeight: H } = map.getContainer()
    if (!W || !H) return

    const nw = map.unproject([-MARGIN, -MARGIN])
    const se = map.unproject([W + MARGIN, H + MARGIN])
    const bbox = [
      Math.max(-180, nw.lng), Math.max(-85, se.lat),
      Math.min(180, se.lng),  Math.min(85, nw.lat),
    ]
    const inBox = (p) => p.lng >= bbox[0] && p.lng <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3]
    const toScreen = (lng, lat) => map.project([lng, lat])

    const { byId, rank } = lookupRef.current
    const selectedId = selectedRef.current?.id ?? null
    const priorityIds = [...new Set([selectedId, ...(compareRef.current ?? [])])]
      .filter(id => byId.has(id))
    const loose = priorityIds
      .map(id => byId.get(id))
      .filter(inBox)
      .map(p => ({ projectId: p.id, lng: p.lng, lat: p.lat }))

    const groups = screenGroups(index, bbox, map.getZoom(), toScreen, loose)

    /* Names where they fit, numbers where they don't: every project in view
       ends up as a name pill, a dot, or counted inside a bubble. */
    const input = groups.map(g => {
      const coords = groupMembers(index, g).filter(m => byId.has(m.projectId))
      const at = toScreen(g.lng, g.lat)
      return {
        group: g,
        coords,
        key: g.key,
        kind: g.kind,
        x: at.x,
        y: at.y,
        ...(g.kind === 'cluster' ? bubbleSize(g.count) : {}),
        members: coords.map(m => {
          const pt = toScreen(m.lng, m.lat)
          return { id: m.projectId, x: pt.x, y: pt.y }
        }),
      }
    }).filter(g => g.members.length)

    /* Interface floating over the map (list panel / sheet, Compare, the
       switcher, zoom buttons, an open drawer) — names keep clear of it
       instead of being cut in half underneath. */
    const view = map.getContainer().getBoundingClientRect()
    const obstacles = [...document.querySelectorAll(
      '.list-panel, .tools-panel, .mapmode--visible, .map-zoom--visible, .pdrawer:not(.pdrawer--closing), .compare-bar',
    )]
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width && r.height)
      .map(r => ({ x1: r.left - view.left, y1: r.top - view.top, x2: r.right - view.left, y2: r.bottom - view.top }))

    const { bubbles, pins } = placeMarkers(input, {
      labelOf: (id) => pinLabel(byId.get(id)),
      priorityIds,
      rankOf: (id) => rank.get(id) ?? 1e9,
      obstacles,
    })

    // bubbles — whatever is left inside a group once names stepped out
    // (plus any squeezed-in neighbour that joined it)
    const liveBubbles = new Set()
    for (const g of input) {
      const ids = bubbles.get(g.key)
      if (!ids) continue
      const members = ids.map(id => {
        const p = byId.get(id)
        return { projectId: id, lng: p.lng, lat: p.lat }
      })
      const own = new Set(g.coords.map(m => m.projectId))
      const partial = members.length !== g.coords.length || ids.some(id => !own.has(id))
      const bubble = {
        key: partial ? `${g.key}~${members.length}~${ids.reduce((s, id) => s + id, 0)}` : g.key,
        count: members.length,
        lng: g.group.lng,
        lat: g.group.lat,
        members,
        splitZoom: partial ? 0 : splitZoomOf(index, g.group),
      }
      liveBubbles.add(bubble.key)
      ensureCluster(bubble, map)
    }
    clusterMarkers.current.forEach((entry, key) => {
      if (liveBubbles.has(key)) return
      entry.marker.remove()
      clusterMarkers.current.delete(key)
    })

    // name pills and dots — priority: selected / compare, then list order
    const livePins = new Set()
    for (const [id, mode] of pins) {
      const p = byId.get(id)
      livePins.add(id)
      ensurePin(p, map, mode, pinLabel(p))
      const entry = pinMarkers.current.get(id)
      if (entry) {
        entry.priority = rank.get(id) ?? 1e9
        entry.pinned = priorityIds.includes(id)
      }
    }
    pinMarkers.current.forEach((entry, id) => {
      if (livePins.has(id)) return
      entry.marker.remove()
      pinMarkers.current.delete(id)
    })

    scheduleRepair()
  }

  /* One marker per bubble, keyed by the projects it holds — a bubble that
     survives a settle keeps its element, so nothing flashes. */
  const ensureCluster = (group, map) => {
    const existing = clusterMarkers.current.get(group.key)
    if (existing) { existing.group = group; return }

    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'cluster-pin'
    el.innerHTML = `<strong>${group.count}</strong>`
    el.setAttribute('aria-label', `${group.count} projects — zoom in`)
    const entry = { el, group, marker: null }
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      focusGroup(entry.group)
    })
    entry.marker = new Marker({ element: el }).setLngLat([group.lng, group.lat]).addTo(map)
    clusterMarkers.current.set(group.key, entry)
  }

  /* Any sync can promote a marker back to a pill (model-based), so the
     measured repair must follow every sync — debounced so it costs one
     pass once movement settles, not one per frame. */
  const repairTimer = useRef(null)
  const scheduleRepair = () => {
    clearTimeout(repairTimer.current)
    repairTimer.current = setTimeout(() => repairPass(), 120)
  }

  /* Second pass against the measured DOM — estimated text metrics and
     marker transforms drift a few px, so verify what is actually on
     screen and demote anything that still touches a neighbour. */
  const repairPass = () => {
    const map = mapRef.current
    if (!map) return

    /* Run after the browser has laid the markers out. rAF is the right
       signal, but it is throttled in background/embedded views — a timeout
       guard makes sure the measured repair still happens there. */
    let ran = false
    const runRepair = () => {
      if (ran) return
      ran = true

      /* Where a marker really sits: its map position plus its rendered size.
         getBoundingClientRect() would be wrong here — markers ease into
         place with a CSS transform transition, so right after a move they
         measure mid-slide and look like they collide when they don't. */
      const markerRect = (entry) => {
        const { x, y } = map.project(entry.marker.getLngLat())
        const w = entry.el.offsetWidth, h = entry.el.offsetHeight
        return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 }
      }

      /* Bubbles and the selected / compare pins are never demoted — every
         other pin has to find room around them. */
      const fixedRects = [
        ...[...clusterMarkers.current.values()].map(markerRect),
        ...[...pinMarkers.current.values()]
          .filter(e => e.pinned && e.mode !== 'hidden')
          .map(markerRect),
      ]

      /* Source markers from the LIVE DOM (not a cached order array, which
         can go stale between passes) and sort by the priority stamped on
         each element, so every rendered marker is always checked. */
      for (let attempt = 0; attempt < 3; attempt++) {
        const live = [...pinMarkers.current.entries()]
          .filter(([, e]) => e.mode !== 'hidden' && !e.pinned)
          .sort((a, b) => (a[1].priority ?? 1e9) - (b[1].priority ?? 1e9))
          .map(([id]) => id)

        // every project stays on the map: a drifted name shrinks to a dot,
        // it is never removed
        const changed = repairOverlaps(live, (id) => {
          const entry = pinMarkers.current.get(id)
          if (!entry) return null
          return {
            mode: entry.mode,
            rect: () => markerRect(entry),
            setMode: (m) => applyMode(entry, m),
          }
        }, 6, fixedRects, { canHide: false })
        if (changed === 0) break   // stable
      }
    }
    requestAnimationFrame(runRepair)
    setTimeout(runRepair, 40)
  }

  /* Single place that mutates a marker's render mode */
  const applyMode = (entry, mode) => {
    if (entry.mode === mode) return
    entry.mode = mode
    /* toggle our classes only — assigning className would wipe MapLibre's
       `maplibregl-marker` class, which is what positions the marker
       absolutely; without it pins fall into normal flow and land far from
       their project */
    entry.el.classList.toggle('price-pin', mode === 'pill')
    entry.el.classList.toggle('dot-pin', mode !== 'pill')
    entry.el.textContent   = mode === 'pill' ? entry.label : ''
    entry.el.style.display = mode === 'hidden' ? 'none' : ''
    entry.el.setAttribute('aria-label', entry.aria ?? entry.label)
  }

  const ensurePin = (project, map, mode, label) => {
    let entry = pinMarkers.current.get(project.id)

    if (!entry) {
      const el = document.createElement('button')
      el.type = 'button'
      el.addEventListener('mouseenter', () => {
        el.classList.add('map-pin--hover')
        showHoverCard(project, el)
      })
      el.addEventListener('mouseleave', () => {
        el.classList.remove('map-pin--hover')
        hideHoverCard()
      })
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        callbacksRef.current.onSelectProject(project)
      })
      const marker = new Marker({ element: el }).setLngLat([project.lng, project.lat]).addTo(map)
      entry = { marker, el, mode: null }
      pinMarkers.current.set(project.id, entry)
    }

    entry.label = label
    entry.aria  = `${project.name} — ${project.developer} — from ${project.price}`
    applyMode(entry, mode)

    entry.el.classList.toggle('price-pin--selected', selectedRef.current?.id === project.id)
    entry.el.classList.toggle('price-pin--compare', compareRef.current?.includes(project.id))
  }

  /* ── new cluster index (projects / selection / compare) → new bubbles ─
     Declared before the selection effect so bubbles are rebuilt before a
     selection starts flying the camera. */
  useEffect(() => {
    if (!mapReady) return
    clusterMarkers.current.forEach(entry => entry.marker.remove())
    clusterMarkers.current.clear()
    syncLayers(); repairPass()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterIndex, mapReady])

  /* Tap a bubble → frame exactly the projects it holds, centred in the
     strip of map the broker can see. The zoom never stops short of where
     the bubble breaks apart, so every tap makes progress. */
  const focusGroup = (bubble) => {
    const map = mapRef.current
    if (!map || !bubble?.members?.length) return
    disarmWatchdog()
    try { map.setProjection({ type: 'mercator' }) } catch { /* ignore */ }

    const bounds = boundsOf(bubble.members)
    const pad = fitPadding()
    let fit = FIT_MAX_ZOOM
    try {
      const cam = map.cameraForBounds(bounds, { padding: pad, maxZoom: FIT_MAX_ZOOM })
      if (cam) fit = cam.zoom
    } catch { /* keep the cap */ }

    const [[w, s], [e, n]] = bounds
    setCamera(map, {
      kind: 'fly',
      opts: {
        center: [(w + e) / 2, midLat(s, n)],
        zoom: Math.min(Math.max(fit, bubble.splitZoom), FIT_MAX_ZOOM),
        offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2],
        duration: 1400,
        essential: true,
      },
    })
  }

  /* ── refresh pins when the filtered project set changes ────────────── */
  useEffect(() => {
    if (!mapReady) return
    pinMarkers.current.forEach(entry => entry.marker.remove())
    pinMarkers.current.clear()
    hideHoverCard()
    syncLayers(); repairPass()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, mapReady])

  /* ── selected project: fly + re-run declutter so it wins a pill ────── */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !selectedProject) return
    disarmWatchdog()
    map.flyTo({
      center: [selectedProject.lng, selectedProject.lat],
      zoom: Math.max(map.getZoom(), 13.5),
      offset: focusOffset(true),   // the drawer opens with this selection
      duration: 1400,
      essential: true,
    })
    syncLayers(); repairPass()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, mapReady])

  /* ── project added to compare from the list: fly there ─────────────────
     The flight is paced by how far it goes: a hop across the neighbourhood
     is quick, a jump between cities arcs out and back in, never dragging
     past FLY_MAX_MS. (MapLibre's own `maxDuration` is no use here — a flight
     longer than it doesn't get capped, it jumps with no animation at all.)
     The pick is never folded into a bubble, so it lands on its own name
     pill, which pings to say "this one". */
  const COMPARE_ZOOM = 13
  const FLY_MIN_MS = 900
  const FLY_MAX_MS = 2200
  compareFocusRef.current = compareFocus

  const pingPin = (id) => {
    const el = pinMarkers.current.get(id)?.el
    if (!el) return
    el.classList.remove('pin--landed')
    void el.offsetWidth                       // restart the animation
    el.classList.add('pin--landed')
    el.addEventListener('animationend', () => el.classList.remove('pin--landed'), { once: true })
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !compareFocus) return
    const project = lookupRef.current.byId.get(compareFocus.id)
    if (!project) return
    const { seq } = compareFocus

    // on phones the sheet may still be easing down — measure once it settles
    const timer = setTimeout(() => {
      disarmWatchdog()
      try { map.setProjection({ type: 'mercator' }) } catch { /* ignore */ }

      // centre in the visible strip; wider layouts also lose the bottom to
      // the compare tray
      const [ox, oy] = focusOffset(false)
      const tray = layoutRef.current !== 'mobile'
        ? document.querySelector('.compare-bar')?.getBoundingClientRect()
        : null
      const offset = [ox, tray ? oy - Math.round((tray.height + 16) / 2) : oy]
      const zoom = Math.max(map.getZoom(), COMPARE_ZOOM)

      // how far the camera travels: on-screen distance plus the zoom change
      const { clientWidth: W, clientHeight: H } = map.getContainer()
      const at = map.project([project.lng, project.lat])
      const travel = Math.hypot(at.x - (W / 2 + offset[0]), at.y - (H / 2 + offset[1]))
      const duration = Math.round(Math.min(FLY_MAX_MS,
        Math.max(FLY_MIN_MS, 700 + travel * 0.8 + Math.abs(zoom - map.getZoom()) * 160)))

      setCamera(map, {
        kind: 'fly',
        opts: {
          center: [project.lng, project.lat],
          zoom,
          offset,
          duration,
          curve: 1.42,
          essential: true,
        },
      })

      const land = () => { if (compareFocusRef.current?.seq === seq) pingPin(project.id) }
      if (map.isMoving()) map.once('moveend', land)
      else land()   // already there — no flight, ping straight away
    }, layoutRef.current === 'mobile' ? 340 : 0)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareFocus, mapReady])

  /* ── compare selection: re-run sync so pin classes stay accurate ───── */
  useEffect(() => {
    if (mapReady) syncLayers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareSelection, mapReady])

  return (
    <div className="map-canvas">
      <div ref={containerRef} className="map-canvas-gl" />

      {/* Map / Satellite switcher — NAVI hand-off component */}
      <div className={`mapmode${introDone ? ' mapmode--visible' : ''}`}>
        <span className={`mapmode-thumb${mapType === 'sat' ? ' mapmode-thumb--right' : ''}`} />
        <button
          type="button"
          className={`mapmode-tab${mapType === 'map' ? ' mapmode-tab--active' : ''}`}
          onClick={() => setMapType('map')}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7.5 3.75 3.6 5.2a1 1 0 0 0-.6.94v9.1c0 .7.7 1.18 1.35.94L7.5 15l5 1.25 3.55-1.45a1 1 0 0 0 .6-.94V4.76c0-.7-.7-1.18-1.35-.94L12.5 5l-5-1.25Z"
              stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
            <path d="M7.5 3.75V15M12.5 5v11.25" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          </svg>
          Map
        </button>
        <button
          type="button"
          className={`mapmode-tab${mapType === 'sat' ? ' mapmode-tab--active' : ''}`}
          onClick={() => setMapType('sat')}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="m3.1 10.4 9.65-5.57a1.5 1.5 0 0 1 2.05.55l1 1.73a1.5 1.5 0 0 1-.55 2.05l-9.65 5.57a1.5 1.5 0 0 1-2.05-.55l-1-1.73a1.5 1.5 0 0 1 .55-2.05Z"
              stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
            <path d="m8.4 12.3 1.9 4.45M6.2 16.9l3-1.4M13.4 5.6l1.2-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          Satellite
        </button>
      </div>

      {/* Zoom controls — bottom of the map */}
      <div className={`map-zoom${introDone ? ' map-zoom--visible' : ''}`}>
        <button
          type="button"
          className="map-zoom-btn"
          aria-label="Zoom in"
          onClick={() => mapRef.current?.zoomIn({ duration: 300 })}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          className="map-zoom-btn"
          aria-label="Zoom out"
          onClick={() => mapRef.current?.zoomOut({ duration: 300 })}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4.5 10h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {children}
    </div>
  )
}
