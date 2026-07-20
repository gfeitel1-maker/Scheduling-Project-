import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Shell({ children, currentScreen, onNavigate, campId, onLogout, sidebarBadges }) {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={currentScreen} onNavigate={onNavigate} campId={campId} badges={sidebarBadges} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar screen={currentScreen} onLogout={onLogout} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
