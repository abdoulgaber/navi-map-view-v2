import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { projects } from '../data/projects.js'
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
  /* A project added to compare from the LIST is flown to on the map, so the
     broker sees where it sits (picks made on the map are already in view) */
  const [compareFocus, setCompareFocus] = useState(null)   // { id, seq }

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

  /* Everything in the chosen category — the list and the map's clusters */
  const inCategory = useMemo(
    () => sortProjects(baseFiltered.filter(CATEGORY_MATCH[category]), sort),
    [baseFiltered, category, sort],
  )

  const filtered = inCategory

  // restart paging whenever the result set changes underneath the panel
  useEffect(() => { setVisibleCount(PAGE) }, [filtered])

  const compareItems = useMemo(
    () => compareSel.map(id => projects.find(p => p.id === id)).filter(Boolean),
    [compareSel],
  )

  /* ── selection & compare routing ───────────────────────────────────── */
  // no cap on how many projects can be compared
  const toggleCompareItem = useCallback((id) => {
    setCompareSel(sel => (sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]))
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

  /* List cards: in compare mode, a project being ADDED also flies the map to
     it. On phones a full-height sheet eases down to half so the flight shows. */
  const handleCardClick = useCallback((project) => {
    if (compareMode && !compareSel.includes(project.id)) {
      setCompareFocus(f => ({ id: project.id, seq: (f?.seq ?? 0) + 1 }))
      if (isCompact) setSheet(s => (s === 'full' ? 'half' : s))
    }
    handleProjectClick(project)
  }, [compareMode, compareSel, isCompact, handleProjectClick])

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
            <span className="list-hint"> · tap a number on the map to zoom in</span>
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
                onClick={handleCardClick}
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
        selectedProject={selectedProject}
        onSelectProject={handleProjectClick}
        compareSelection={compareSel}
        compareFocus={compareFocus}
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
