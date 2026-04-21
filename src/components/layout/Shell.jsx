import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Shell({ children, currentScreen, onNavigate }) {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar current={currentScreen} onNavigate={onNavigate} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar screen={currentScreen} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
