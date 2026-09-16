import { useEffect } from 'react'

/** Side drawer showing the selected projects (two or more) side by side */
export default function CompareDrawer({ items, onClose }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-header">
          <div className="drawer-header-meta">
            <span className="drawer-developer">Units Comparison</span>
            <span className="drawer-location">
              Pre-filtered by: {items.map(p => `${p.developer} — ${p.name}`).join(' · ')}
            </span>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5L15 15" stroke="#475467" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="drawer-body" style={{ padding: '20px 24px' }}>
          <div className="drawer-table-wrapper">
            <table className="drawer-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Developer</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th>Start BUA</th>
                  <th>Starts EGP</th>
                  <th>Delivery</th>
                  <th>Cash Disc.</th>
                </tr>
              </thead>
              <tbody>
                {items.map(p => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>{p.developer}</td>
                    <td>{p.location}</td>
                    <td>{p.type}</td>
                    <td>{p.bua}</td>
                    <td>{p.price}</td>
                    <td>{p.delivery}</td>
                    <td>{p.cashDiscount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </aside>
    </>
  )
}
