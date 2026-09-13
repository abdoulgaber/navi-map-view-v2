import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { projects, BASE_LOCATIONS } from '../data/projects.js'
import { applyFilters } from './FilterBar.jsx'
import { sortProjects } from './ControlsBar.jsx'
import ProjectCard from './ProjectCard.jsx'
import ProjectDrawer from './ProjectDrawer.jsx'
import CompareBar from './CompareBar.jsx'
import CompareDrawer from './CompareDrawer.jsx'
import MapCanvas from './MapCanvas.jsx'
import { useBreakpoint } from '../hooks/useBreakpoint.js'

/** Mixed-use projects appear in both categories */
const CATEGORY_MATCH = {
  Residential: (p) => p.type === 'Residential' || p.type === 'Mixed',
  Commercial:  (p) => p.type === 'Commercial'  || p.type === 'Mixed',
}

/** Residential ⇄ Commercial segmented tabs (NAVI hand-off style) */
function CategoryTabs({ category, onChange, counts }) {
  return (
    <div className="ctabs">
      {['Residential', 'Commercial'].map(c => (
        <button
          key={c}
          type="button"
          className={`ctab${category === c ? ' ctab--active' : ''}`}
          onClick={() => onChange(c)}
        >
          {c}
          {c === 'Commercial' && <sup className="ctab-new">New</sup>}
          <span className="ctab-count">{counts[c]}</span>
        </button>
      ))}
    </div>
  )
}

export default function MapView({ filters, search, sort }) {
  const [category,        setCategory]        = useState('Residential')
  const [selectedProject, setSelectedProject] = useState(null)
  const [drawerProject,   setDrawerProject]   = useState(null)
  const [drawerClosing,   setDrawerClosing]   = useState(false)

  /* Compare mode */
  const [compareMode, setCompareMode] = useState(false)
  const [compareSel,  setCompareSel]  = useState([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareMax,  setCompareMax]  = useState(false)

  const listRef = useRef(null)

  /* On phones and tablets the list lives in a sheet over the map. It has
     three heights so a broker can go from "mostly map" to "mostly list"
     with one drag, the way native map apps behave. */
  const { isMobile, isCompact } = useBreakpoint()
  const [sheet, setSheet] = useState('half')   // 'peek' | 'half' | 'full'
  const dragRef = useRef(null)

  /* The map handles 1,400+ projects fine, but rendering that many cards
     would choke the panel — reveal them as the broker scrolls. */
  const PAGE = 40
  const [visibleCount, setVisibleCount] = useState(PAGE)

  /* ── pipeline: filters+search → category → sort ────────────────────── */
  const baseFiltered = useMemo(
    () => applyFilters(projects, search, filters),
    [search, filters],
  )

  const counts = useMemo(() => ({
    Residential: baseFiltered.filter(CATEGORY_MATCH.Residential).length,
    Commercial:  baseFiltered.filter(CATEGORY_MATCH.Commercial).length,
  }), [baseFiltered])

  /* Everything in the chosen category — drives the zone badges */
  const inCategory = useMemo(
    () => sortProjects(baseFiltered.filter(CATEGORY_MATCH[category]), sort),
    [baseFiltered, category, sort],
  )

  const filtered = inCategory

  // restart paging whenever the result set changes underneath the panel
  useEffect(() => { setVisibleCount(PAGE) }, [filtered])

  const zones = useMemo(() =>
    BASE_LOCATIONS
      .map(loc => {
        const inZone = inCategory.filter(p => p.location === loc.area)
        return {
          ...loc,
          count: inZone.length,
          points: inZone.map(p => [p.lng, p.lat]),
        }
      })
      .filter(z => z.count > 0),
    [inCategory],
  )

  const compareItems = useMemo(
    () => compareSel.map(id => projects.find(p => p.id === id)).filter(Boolean),
    [compareSel],
  )

  /* ── selection & compare routing ───────────────────────────────────── */
  const toggleCompareItem = useCallback((id) => {
    setCompareSel(sel => {
      if (sel.includes(id)) return sel.filter(x => x !== id)
      if (sel.length >= 4) {
        setCompareMax(true)
        setTimeout(() => setCompareMax(false), 1500)
        return sel
      }
      return [...sel, id]
    })
  }, [])

  const handleProjectClick = useCallback((project) => {
    if (compareMode) { toggleCompareItem(project.id); return }
    setSelectedProject(project)
    setDrawerProject(project)
    setDrawerClosing(false)
    if (isCompact) setSheet('peek')   // let the map breathe behind the drawer
    listRef.current
      ?.querySelector(`[data-id="${project.id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [compareMode, toggleCompareItem, isCompact])

  /* Let the panel play its 400ms exit before it leaves the tree */
  const DRAWER_ANIM_MS = 400
  const handleCloseDrawer = useCallback(() => {
    setDrawerClosing(true)
    setSelectedProject(null)
    setTimeout(() => {
      setDrawerProject(null)
      setDrawerClosing(false)
    }, DRAWER_ANIM_MS)
  }, [])

  /* One mode at a time: comparing retires the single-project drawer, which
     would otherwise sit over the compare tray and its actions */
  const toggleCompareMode = useCallback(() => {
    const next = !compareMode
    setCompareMode(next)
    if (!next) setCompareSel([])
    else if (drawerProject) handleCloseDrawer()
  }, [compareMode, drawerProject, handleCloseDrawer])

  /* Drag / flick the sheet between its three stops */
  const onSheetPointerDown = (e) => {
    dragRef.current = { y: e.clientY, at: Date.now(), from: sheet }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onSheetPointerUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const dy = e.clientY - d.y
    const quick = Date.now() - d.at < 300
    if (Math.abs(dy) < 24 && quick) {           // tap the handle → next stop
      setSheet(s => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'))
      return
    }
    const order = ['peek', 'half', 'full']
    const i = order.indexOf(d.from)
    if (dy < -40) setSheet(order[Math.min(i + 1, 2)])
    else if (dy > 40) setSheet(order[Math.max(i - 1, 0)])
  }

  const sheetClass = isCompact ? ` list-panel--sheet list-panel--${sheet}` : ''

  return (
    <div className={`map-view${isCompact ? ' map-view--compact' : ''}${compareMode ? ' map-view--comparing' : ''}`}>
      {/* Left panel */}
      <aside className={`list-panel${sheetClass}`}>
        {isCompact && (
          <div
            className="sheet-grip"
            onPointerDown={onSheetPointerDown}
            onPointerUp={onSheetPointerUp}
            role="button"
            tabIndex={0}
            aria-label="Resize list"
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp')   setSheet(s => (s === 'peek' ? 'half' : 'full'))
              if (e.key === 'ArrowDown') setSheet(s => (s === 'full' ? 'half' : 'peek'))
            }}
          >
            <span />
          </div>
        )}
        <div className="list-panel-top">
          <CategoryTabs category={category} onChange={setCategory} counts={counts} />
          <div className="list-count">
            <strong>{filtered.length.toLocaleString()}</strong>
            {' '}{category.toLowerCase()} project{filtered.length !== 1 ? 's' : ''} found
            <span className="list-hint"> · tap an area on the map to zoom to it</span>
          </div>
        </div>
        <div
          className="list-scroll"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
              setVisibleCount(c => Math.min(c + PAGE, filtered.length))
            }
          }}
        >
          {filtered.length === 0 && (
            <div className="list-empty">
              <span>🔍</span>
              <p>No projects match your filters.</p>
              <small>Try adjusting your search or clearing some filters.</small>
            </div>
          )}
          {filtered.slice(0, visibleCount).map(project => (
            <div key={project.id} data-id={project.id} className="pcard-slot">
              <ProjectCard
                project={project}
                active={selectedProject?.id === project.id}
                compareSelected={compareSel.includes(project.id)}
                onClick={handleProjectClick}
              />
            </div>
          ))}
          {visibleCount < filtered.length && (
            <div className="list-more">
              Showing {visibleCount} of {filtered.length.toLocaleString()} — scroll for more
            </div>
          )}
        </div>
      </aside>

      {/* Map + overlays */}
      <MapCanvas
        projects={filtered}
        zones={zones}
        selectedProject={selectedProject}
        onSelectProject={handleProjectClick}
        compareSelection={compareSel}
        layout={isMobile ? 'mobile' : isCompact ? 'tablet' : 'desktop'}
      >
        {/* Compare — NAVI hand-off button: white when idle, blue with a
            count and a dismiss when the mode is on */}
        <div className="tools-panel">
          <button
            type="button"
            className={`compare-btn${compareMode ? ' compare-btn--on' : ''}`}
            onClick={toggleCompareMode}
          >
            Compare{compareMode && compareSel.length > 0 ? ` (${compareSel.length})` : ''}
            {compareMode && (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M14.5 5.5l-9 9M5.5 5.5l9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        </div>

        <CompareBar
          visible={compareMode}
          items={compareItems}
          maxHit={compareMax}
          onRemove={toggleCompareItem}
          onClear={() => setCompareSel([])}
          onView={() => setCompareOpen(true)}
        />
      </MapCanvas>

      {/* Drawers */}
      {drawerProject && (
        <ProjectDrawer project={drawerProject} onClose={handleCloseDrawer} closing={drawerClosing} />
      )}
      {compareOpen && (
        <CompareDrawer items={compareItems} onClose={() => setCompareOpen(false)} />
      )}
    </div>
  )
}
