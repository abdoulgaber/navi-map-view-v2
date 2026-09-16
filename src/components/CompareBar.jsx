/** Bottom bar shown in compare mode: selection chips + actions */
export default function CompareBar({ visible, items, onRemove, onClear, onView }) {
  if (!visible) return null

  return (
    <div className="compare-bar">
      <div className="compare-chips">
        {items.length === 0 && (
          <span className="compare-hint">Tap 2 or more projects on the map or list to compare</span>
        )}
        {items.map(p => (
          <span key={p.id} className="compare-chip">
            {p.name}
            <button type="button" onClick={() => onRemove(p.id)}>×</button>
          </span>
        ))}
      </div>
      <div className="compare-actions">
        <button type="button" className="compare-clear" onClick={onClear}>Clear</button>
        <button type="button" className="compare-view" disabled={items.length < 2} onClick={onView}>
          Compare ({items.length})
        </button>
      </div>
    </div>
  )
}
