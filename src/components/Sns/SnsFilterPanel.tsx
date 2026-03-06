import React from 'react'
import { Search, User, X, Loader2 } from 'lucide-react'
import { Avatar } from '../Avatar'

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
    postCount?: number
    postCountStatus?: 'idle' | 'loading' | 'ready'
}

interface ContactsCountProgress {
    resolved: number
    total: number
    running: boolean
}

interface SnsFilterPanelProps {
    searchKeyword: string
    setSearchKeyword: (val: string) => void
    totalFriendsLabel?: string
    selectedUsernames: string[]
    setSelectedUsernames: (val: string[]) => void
    contacts: Contact[]
    contactSearch: string
    setContactSearch: (val: string) => void
    loading?: boolean
    contactsCountProgress?: ContactsCountProgress
}

export const SnsFilterPanel: React.FC<SnsFilterPanelProps> = ({
    searchKeyword,
    setSearchKeyword,
    totalFriendsLabel,
    selectedUsernames,
    setSelectedUsernames,
    contacts,
    contactSearch,
    setContactSearch,
    loading,
    contactsCountProgress
}) => {
    const filteredContacts = contacts.filter(c =>
        (c.displayName || '').toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.username.toLowerCase().includes(contactSearch.toLowerCase())
    )

    const toggleUserSelection = (username: string) => {
        if (selectedUsernames.includes(username)) {
            setSelectedUsernames(selectedUsernames.filter(u => u !== username))
        } else {
            setSelectedUsernames([...selectedUsernames, username])
        }
    }

    const clearFilters = () => {
        setSearchKeyword('')
        setSelectedUsernames([])
    }

    const getEmptyStateText = () => {
        if (loading && contacts.length === 0) {
            return '正在加载联系人...'
        }
        if (contacts.length === 0) {
            return '暂无好友或曾经的好友'
        }
        return '没有找到联系人'
    }

    return (
        <aside className="sns-filter-panel">
            <div className="filter-header">
                <h3>筛选条件</h3>
                {(searchKeyword || selectedUsernames.length > 0) && (
                    <button className="reset-all-btn" onClick={clearFilters} title="重置所有筛选">
                        <RefreshCw size={14} />
                    </button>
                )}
            </div>

            <div className="filter-widgets">
                {/* Search Widget */}
                <div className="filter-widget search-widget">
                    <div className="widget-header">
                        <Search size={14} />
                        <span>关键词搜索</span>
                    </div>
                    <div className="input-group">
                        <input
                            type="text"
                            placeholder="搜索动态内容..."
                            value={searchKeyword}
                            onChange={e => setSearchKeyword(e.target.value)}
                        />
                        {searchKeyword && (
                            <button className="clear-input-btn" onClick={() => setSearchKeyword('')}>
                                <X size={14} />
                            </button>
                        )}
                    </div>
                </div>
                {/* Contact Widget */}
                <div className="filter-widget contact-widget">
                    <div className="widget-header">
                        <User size={14} />
                        <span>联系人</span>
                        {selectedUsernames.length > 0 && (
                            <span className="badge">{selectedUsernames.length}</span>
                        )}
                        {totalFriendsLabel && (
                            <span className="widget-header-summary">{totalFriendsLabel}</span>
                        )}
                    </div>

                    <div className="contact-search-bar">
                        <input
                            type="text"
                            placeholder="查找好友..."
                            value={contactSearch}
                            onChange={e => setContactSearch(e.target.value)}
                        />
                        <Search size={14} className="search-icon" />
                        {contactSearch && (
                            <X size={14} className="clear-icon" onClick={() => setContactSearch('')} />
                        )}
                    </div>

                    {contactsCountProgress && contactsCountProgress.total > 0 && (
                        <div className="contact-count-progress">
                            {contactsCountProgress.running
                                ? `朋友圈条数统计中 ${contactsCountProgress.resolved}/${contactsCountProgress.total}`
                                : `朋友圈条数已统计 ${contactsCountProgress.total}/${contactsCountProgress.total}`}
                        </div>
                    )}

                    <div className="contact-list-scroll">
                        {filteredContacts.map(contact => {
                            const isPostCountReady = contact.postCountStatus === 'ready'
                            return (
                            <div
                                key={contact.username}
                                className={`contact-row ${selectedUsernames.includes(contact.username) ? 'selected' : ''}`}
                                onClick={() => toggleUserSelection(contact.username)}
                            >
                                <Avatar src={contact.avatarUrl} name={contact.displayName} size={36} shape="rounded" />
                                <div className="contact-meta">
                                    <span className="contact-name">{contact.displayName}</span>
                                </div>
                                <div className="contact-post-count-wrap">
                                    {isPostCountReady ? (
                                        <span className="contact-post-count">{Math.max(0, Math.floor(Number(contact.postCount || 0)))}条</span>
                                    ) : (
                                        <span className="contact-post-count-loading" title="统计中">
                                            <Loader2 size={13} className="spinning" />
                                        </span>
                                    )}
                                </div>
                            </div>
                            )
                        })}
                        {filteredContacts.length === 0 && (
                            <div className="empty-state">{getEmptyStateText()}</div>
                        )}
                    </div>
                </div>
            </div>
        </aside>
    )
}

function RefreshCw({ size, className }: { size?: number, className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size || 24}
            height={size || 24}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
    )
}
