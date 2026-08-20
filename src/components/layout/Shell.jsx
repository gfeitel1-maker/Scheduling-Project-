import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { useSetupCounts } from '../../hooks/useSetupCounts'

export default function Shell({ children, currentScreen, onNavigate, campId, role, onLogout, sidebarBadges }) {
  const sidebarData = useSetupCounts(campId)

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={currentScreen} onNavigate={onNavigate} campId={campId} role={role} badges={sidebarBadges} {...sidebarData} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar screen={currentScreen} onNavigate={onNavigate} onLogout={onLogout} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
