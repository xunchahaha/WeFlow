import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import './TitleBar.scss'

interface TitleBarProps {
  title?: string
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}

function TitleBar({ title, sidebarCollapsed = false, onToggleSidebar }: TitleBarProps = {}) {
  return (
    <div className="title-bar">
      <div className="title-brand">
        <img src="./logo.png" alt="WeFlow" className="title-logo" />
        <span className="titles">{title || 'WeFlow'}</span>
        {onToggleSidebar ? (
          <button
            type="button"
            className="title-sidebar-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default TitleBar
