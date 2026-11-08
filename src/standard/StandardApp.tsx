import ErrorLogAction from '../components/ErrorLogAction'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bot, CalendarRange, CheckCircle2, CircleAlert, Copy, Crown, Download, ExternalLink, FileOutput, FolderOpen, Image as ImageIcon, Info, Layers, LoaderCircle, LockKeyhole, MessageCircle, MessageSquareText, Minus, Monitor, Play, PlugZap, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Square, Unplug, Users, X } from 'lucide-react'
import type { StandardAPI, StandardSnapshot, StandardSession, StandardMessage, StandardFormat, StandardGroupInfo } from '../../shared/standardExport'
declare global { interface Window { standardAPI: StandardAPI } }
const formats: Array<[StandardFormat, string]> = [['chatlab', 'ChatLab'], ['chatlab-jsonl', 'ChatLab JSONL'], ['json', 'JSON'], ['arkme-json', 'Arkme JSON'], ['html', 'HTML 网页'], ['markdown', 'Markdown'], ['txt', 'TXT 文本'], ['excel', 'Excel'], ['weclone', 'WeClone CSV'], ['sql', 'PostgreSQL']]
const cleanError = (value: unknown) => String((value as Error)?.message || value).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
function Dialog({ titleId, children, onClose, className = '' }: { titleId: string; children: ReactNode; onClose?: () => void; className?: string }) {
  const frame = useRef<HTMLElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const element = frame.current
    ;(element?.querySelector<HTMLElement>('input, button:not([disabled]), select, [tabindex="0"]') || element)?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="standard-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close.current?.() }}>
    <section ref={frame} className={'standard-modal ' + className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape' && close.current) { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const controls = [...(frame.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); frame.current?.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === frame.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>{children}</section>
  </div>
}
function PurchaseChannelIcon({ channel }: { channel: 'qq' | 'telegram' }) {
  return channel === 'qq'
    ? <svg className="standard-purchase-brand" data-brand="qq" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path fill="#F3B43A" d="M8.3 25.1c-2.4.3-4.1 1.7-3.6 2.8.4.9 3.8 1.5 7.3.6l1.2-2.2-4.9-1.2Zm15.4 0c2.4.3 4.1 1.7 3.6 2.8-.4.9-3.8 1.5-7.3.6l-1.2-2.2 4.9-1.2Z"/>
      <path fill="#25282D" d="M16 2.3c-5.4 0-8.6 4.4-8.6 10.5 0 1-.1 1.8-.5 2.6-2 2.2-3 5.7-2.3 7.6.5 1.5 1.8.2 2.7-1.4C8 26 11.4 28.4 16 28.4s8-2.4 8.7-6.8c.9 1.6 2.2 2.9 2.7 1.4.7-1.9-.3-5.4-2.3-7.6-.4-.8-.5-1.6-.5-2.6 0-6.1-3.2-10.5-8.6-10.5Z"/>
      <ellipse cx="16" cy="20.9" rx="6.7" ry="6.4" fill="#FFF"/>
      <ellipse cx="13" cy="10.1" rx="2.2" ry="3.3" fill="#FFF"/><ellipse cx="19" cy="10.1" rx="2.2" ry="3.3" fill="#FFF"/>
      <ellipse cx="13.6" cy="10.7" rx=".9" ry="1.45" fill="#25282D"/><ellipse cx="18.4" cy="10.7" rx=".9" ry="1.45" fill="#25282D"/>
      <path fill="#F3B43A" d="M10.8 14c1.5-.9 3.2-1.4 5.2-1.4s3.7.5 5.2 1.4c-1.3 1.6-3.1 2.4-5.2 2.4s-3.9-.8-5.2-2.4Z"/>
      <path fill="#E94343" d="M7.7 16c4.7 1.8 11.9 1.8 16.6 0l.8 2.6c-5.3 2.2-12.9 2.2-18.2 0l.8-2.6Z"/><path fill="#E94343" d="m10.4 18.6 3.1.7-.7 5.1-3-1.1.6-4.7Z"/>
    </svg>
    : <svg className="standard-purchase-brand" data-brand="telegram" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="m27.5 5.7-4.2 20.1c-.3 1.4-1.2 1.7-2.3 1.1l-6.4-4.7-3.1 3c-.3.3-.5.5-1.1.5l.5-6.5L22.8 8.5c.5-.5-.1-.7-.8-.3L7.3 17.4 1 15.5c-1.4-.4-1.4-1.4.3-2L25.8 4c1.2-.4 2.1.3 1.7 1.7Z"/>
    </svg>
}
export function StandardApp() {
  const api = window.standardAPI
  const [snapshot, setSnapshot] = useState<StandardSnapshot>({ connected: false, connecting: false, locked: false })
  const [sessions, setSessions] = useState<StandardSession[]>([]), [selected, setSelected] = useState<StandardSession>(), [checked, setChecked] = useState(new Set<string>())
  const [messages, setMessages] = useState<StandardMessage[]>([]), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false)
  const [query, setQuery] = useState(''), [mode, setMode] = useState<'chat' | 'export'>('chat'), [error, setError] = useState(''), [password, setPassword] = useState('')
  const [feature, setFeature] = useState(''), [group, setGroup] = useState<StandardGroupInfo>({ groupName: '', groupNumber: '', joinUrl: '', telegramUrl: '' }), [groupCopied, setGroupCopied] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<StandardSession>()
  const [format, setFormat] = useState<StandardFormat>('html'), [start, setStart] = useState(''), [end, setEnd] = useState(''), [media, setMedia] = useState(true), [avatars, setAvatars] = useState(true)
  const [layout, setLayout] = useState<'shared' | 'per-session'>('per-session'), [conflict, setConflict] = useState<'rename' | 'incremental'>('rename'), [preview, setPreview] = useState('')
  const [mediaPreview, setMediaPreview] = useState<{ kind: 'audio' | 'video'; url: string }>()
  const generation = useRef(0), live = useRef(true), previous = useRef(false)
  const run = async (action: () => Promise<unknown>) => { setError(''); try { await action() } catch (error) { if (live.current) setError(cleanError(error)) } }
  useEffect(() => { setGroupCopied(false) }, [feature])
  useEffect(() => {
    live.current = true
    if (!api) { setError('本机读取接口未加载，请重新打开应用'); return }
    const receive = (value: StandardSnapshot) => {
      if (!live.current) return
      setSnapshot(value)
      if (value.connected && !previous.current) {
        const token = generation.current
        void api.sessions().then(rows => { if (live.current && token === generation.current && previous.current) setSessions(rows) }).catch(value => { if (live.current && token === generation.current) setError(cleanError(value)) })
      }
      if (!value.connected) { generation.current++; setSessions([]); setSelected(undefined); setMessages([]); setChecked(new Set()); setLoading(false); setHasMore(false); setPreview(''); setMediaPreview(undefined); setSessionInfo(undefined) }
      previous.current = value.connected
    }
    const remove = api.onChanged(receive)
    void api.snapshot().then(receive).catch(value => setError(cleanError(value)))
    void api.groupInfo().then(setGroup).catch(() => {})
    return () => { live.current = false; generation.current++; remove() }
  }, [api])
  const connect = () => { if (pending) return; setPending(true); setError(''); void api.connect().then(setSnapshot).catch(value => setError(cleanError(value))).finally(() => setPending(false)) }
  const load = async (session: StandardSession, append = false) => {
    const token = ++generation.current; setSelected(session); setLoading(true)
    if (!append) setMessages([])
    try { const value = await api.messages(session.id, append ? messages.length : 0); if (token === generation.current && live.current) { setMessages(old => append ? [...old, ...value.messages] : value.messages); setHasMore(value.hasMore) } }
    catch (error) { if (token === generation.current) setError(cleanError(error)) }
    finally { if (token === generation.current) setLoading(false) }
  }
  const filtered = sessions.filter(item => (item.name + item.id).toLowerCase().includes(query.toLowerCase()))
  const ids = checked.size ? [...checked] : selected ? [selected.id] : []
  const exportNow = async () => {
    if (!ids.length) { setError('请先勾选需要导出的会话'); return }
    const last = end ? new Date(end + 'T00:00:00') : undefined
    if (last) last.setDate(last.getDate() + 1)
    const range = start || end ? { start: start ? Math.floor(new Date(start + 'T00:00:00').getTime() / 1000) : 0, end: last ? Math.floor(last.getTime() / 1000) - 1 : Math.floor(Date.now() / 1000) } : undefined
    if (range && range.end < range.start) { setError('结束日期不能早于开始日期'); return }
    setSnapshot(await api.export(ids, { format, dateRange: range, exportMedia: media, exportAvatars: avatars, sessionLayout: layout, conflict }))
  }
  const busy = pending || snapshot.connecting, job = snapshot.exportJob
  return <div className="standard-app">
    <header className="standard-title">
      <span className="standard-brand"><MessageCircle size={17} aria-hidden="true"/><strong>WeChatAuto</strong><span>普通版</span></span>
      <div className="standard-window-actions"><button aria-label="最小化" onClick={() => api.window('minimize')}><Minus size={16}/></button><button aria-label="最大化" onClick={() => api.window('maximize')}><Square size={13}/></button><button aria-label="关闭窗口" onClick={() => api.window('close')}><X size={17}/></button></div>
    </header>
    <aside className="standard-nav" aria-label="主导航">
      <button className={mode === 'chat' ? 'active' : ''} aria-label="聊天记录" aria-pressed={mode === 'chat'} title="聊天记录" onClick={() => setMode('chat')}><MessageCircle size={22}/></button>
      <button aria-label="AI Agent" title="AI Agent" onClick={() => setFeature('AI Agent')}><Bot size={22}/></button>
      <button className={mode === 'export' ? 'active' : ''} aria-label="消息导出" aria-pressed={mode === 'export'} title="消息导出" onClick={() => setMode('export')}><Download size={22}/></button>
      <div className="standard-nav-spacer"/>
      <button aria-label="会员功能" title="会员功能" onClick={() => setFeature('极客会员')}><Crown size={22}/></button>
      <button aria-label="设置" title="设置" onClick={() => setFeature('设置与版本')}><Settings size={22}/></button>
    </aside>
    <aside className="standard-sessions" aria-label="会话列表">
      <div className="standard-search"><label><Search size={16} aria-hidden="true"/><input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)}/></label><button disabled={!snapshot.connected} aria-label="刷新会话" title="刷新会话" onClick={() => void run(async () => setSessions(await api.sessions()))}><RefreshCw size={17}/></button></div>
      {!snapshot.connected && !snapshot.locked && <div className="standard-connect"><button className="primary" disabled={busy} aria-busy={busy} onClick={connect}>{busy ? <LoaderCircle size={17} className="standard-spin"/> : <PlugZap size={17}/>}<span>{busy ? '正在连接…' : '一键连接本机微信'}</span></button>{busy && <button onClick={() => void run(async () => setSnapshot(await api.cancelConnection()))}>取消</button>}</div>}
      {!snapshot.locked && (error || snapshot.error) && <p className="standard-error" role="alert"><CircleAlert size={16}/><span>{error || snapshot.error}</span><ErrorLogAction error={error || snapshot.error} source="standard.operation"/></p>}
      {snapshot.connected && <div className="standard-select"><label><input type="checkbox" checked={!!filtered.length && filtered.every(item => checked.has(item.id))} onChange={event => setChecked(event.target.checked ? new Set(filtered.map(item => item.id)) : new Set())}/>全选会话</label><span>已选 {checked.size}</span></div>}
      <div className="standard-session-list">{filtered.map(item => <div className={'standard-session' + (selected?.id === item.id ? ' selected' : '')} key={item.id}>
        <input aria-label={'选择 ' + item.name} type="checkbox" checked={checked.has(item.id)} onChange={event => setChecked(old => { const next = new Set(old); event.target.checked ? next.add(item.id) : next.delete(item.id); return next })}/>
        <button onClick={() => void load(item)} title={item.name + (item.preview ? '\n' + item.preview : '')} aria-current={selected?.id === item.id ? 'true' : undefined}>
          <span className="avatar">{item.avatar ? <img src={item.avatar} alt=""/> : item.group ? <Users size={21}/> : <MessageCircle size={21}/>}</span>
          <span className="standard-session-copy"><strong>{item.name}</strong><small>{item.preview || (item.group ? '群聊记录' : '聊天记录')}</small></span>
        </button>
      </div>)}{snapshot.connected && !filtered.length && <p className="standard-list-empty">{query ? '没有找到匹配的会话' : '暂无可读取的会话'}</p>}</div>
      {snapshot.connected && <div className="standard-session-footer"><button onClick={() => setMode('export')}><Download size={16}/><span>导出已选 {ids.length ? `(${ids.length})` : ''}</span></button><button aria-label="断开微信" title="断开微信" onClick={() => void run(async () => setSnapshot(await api.lock()))}><Unplug size={16}/></button></div>}
    </aside>
    <main className="standard-main">
      {mode === 'chat' ? <>
        <header className="standard-chat-header"><div className="standard-chat-heading"><h1>{selected?.name || '聊天记录'}</h1>{selected && <p>{selected.group ? '群聊记录' : '聊天记录'}<span>仅在本机浏览</span></p>}</div>{selected && <div className="standard-chat-actions"><button className="standard-icon-button" aria-label="查看会话信息" title="查看完整会话信息" onClick={() => setSessionInfo(selected)}><Info size={18}/></button><button onClick={() => setFeature('回复助手')}><Sparkles size={17}/><span>回复助手</span></button></div>}</header>
        <div className="standard-message-list" aria-busy={loading}>
          {!selected && <div className="standard-empty"><MessageSquareText size={48} strokeWidth={1.4} aria-hidden="true"/><h2>{snapshot.connected ? '选择一个会话' : '把值得保留的聊天留下来'}</h2><p>{snapshot.connected ? '浏览完整记录，也可以勾选多个会话一起导出。' : '一键连接本机微信，浏览与导出都在这里。'}</p></div>}
          {messages.map((message, index) => <article key={message.id + '-' + index} className={'standard-message' + (message.mine ? ' mine' : '')}><small><span>{message.sender || selected?.name}</span><time>{message.timestamp ? new Date(message.timestamp * 1000).toLocaleString('zh-CN') : ''}</time></small><div>{message.text}{message.type === 3 && selected && <button onClick={() => void run(async () => { const data = await api.image(selected.id, message.id); if (data) setPreview(data); else setError('本地图片不可用；导出时会保留原始消息信息') })}><ImageIcon size={15}/>查看图片</button>}{[34, 43].includes(message.type) && selected && <button onClick={() => void run(async () => { const value = await api.media(selected.id, message.id); if (value) setMediaPreview(value); else setError('本地音视频不可用；导出时会保留原始消息信息') })}><Play size={15}/>{message.type === 34 ? '播放语音' : '播放视频'}</button>}</div></article>)}
          {loading && <p className="standard-loading" role="status"><LoaderCircle size={16} className="standard-spin"/>正在读取…</p>}
          {hasMore && !loading && selected && <button className="standard-load-more" onClick={() => void load(selected, true)}>读取更多消息</button>}
        </div>
      </> : <section className="standard-export">
        <header className="standard-export-heading"><span className="standard-section-icon"><FileOutput size={23}/></span><div><h1>消息导出</h1><p>把聊天整理成文件，留在自己手里。</p></div><span className="standard-count">已选 {ids.length} 个会话</span></header>
        <div className="standard-export-body">
          <fieldset className="standard-form-section"><legend><SlidersHorizontal size={17}/>文件与整理</legend><div className="standard-form-grid">
            <label>导出格式<select value={format} onChange={event => setFormat(event.target.value as StandardFormat)}>{formats.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
            <label>会话目录<select value={layout} onChange={event => setLayout(event.target.value as 'shared' | 'per-session')}><option value="per-session">每个会话单独目录</option><option value="shared">共用导出目录</option></select></label>
            <label className="standard-field-wide">同名文件处理<select value={conflict} onChange={event => setConflict(event.target.value as 'rename' | 'incremental')}><option value="rename">保留原文件，自动重命名</option><option value="incremental">增量更新并复用媒体</option></select></label>
          </div></fieldset>
          <fieldset className="standard-form-section"><legend><CalendarRange size={17}/>日期范围</legend><p className="standard-field-hint">不设置日期时，导出全部记录。</p><div className="standard-form-grid"><label>开始日期<input type="date" value={start} onChange={event => setStart(event.target.value)}/></label><label>结束日期<input type="date" value={end} onChange={event => setEnd(event.target.value)}/></label></div></fieldset>
          <fieldset className="standard-form-section"><legend><Layers size={17}/>导出内容</legend><div className="standard-checks"><label><input type="checkbox" checked={media} onChange={event => setMedia(event.target.checked)}/><span><strong>导出图片、语音、视频、表情及文件</strong><small>语音保留原始音频</small></span></label><label><input type="checkbox" checked={avatars} onChange={event => setAvatars(event.target.checked)}/><span><strong>包含头像</strong><small>便于辨认聊天中的联系人</small></span></label></div></fieldset>
        </div>
        <footer className="standard-export-actions"><p><ShieldCheck size={16}/>聊天内容只保存在本机</p><button className="primary" disabled={!snapshot.connected || job?.state === 'running' || !ids.length} onClick={() => void run(exportNow)}><Download size={17}/>选择保存位置并开始导出</button></footer>
      </section>}
      {job && <footer className={'standard-job ' + job.state} role="status"><div className="standard-job-icon">{job.state === 'running' ? <LoaderCircle size={19} className="standard-spin"/> : job.state === 'failed' ? <CircleAlert size={19}/> : job.state === 'completed' ? <CheckCircle2 size={19}/> : <Info size={19}/>}</div><div className="standard-job-copy"><strong>{job.message}</strong>{job.state === 'running' && <><progress value={job.current} max={Math.max(1, job.total)}/><small>{job.current} / {job.total}</small></>}{job.error && <details><summary>查看错误详情</summary><p>{job.error}</p></details>}</div>{job.state === 'failed' && <ErrorLogAction error={job.error || job.message} source="standard.export"/>}{job.state === 'running' ? <button onClick={() => void run(async () => setSnapshot(await api.cancelExport()))}>取消导出</button> : <button onClick={() => void run(() => api.openExportDirectory())}><FolderOpen size={16}/><span>打开导出目录</span></button>}</footer>}
    </main>
    {snapshot.locked ? <Dialog key="lock" titleId="standard-lock-title"><form className="standard-dialog-form" onSubmit={event => { event.preventDefault(); void run(async () => { setSnapshot(await api.unlock(password)); setPassword('') }) }}><span className="standard-section-icon"><LockKeyhole size={24}/></span><h2 id="standard-lock-title">解锁本地资料</h2><p>使用此前设置的资料密码，继续在本机浏览。</p>{error && <p className="standard-error" role="alert"><CircleAlert size={16}/><span>{error}</span><ErrorLogAction error={error} source="standard.operation"/></p>}<label className="standard-password">资料密码<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="本地资料密码"/></label><button className="primary">解锁</button>{snapshot.helloAvailable && <button type="button" onClick={() => void run(async () => setSnapshot(await api.hello()))}>使用 Windows Hello</button>}<small className="standard-muted"><ShieldCheck size={15}/>不会登录网络账号或重置资料密码</small></form></Dialog>
      : feature ? <Dialog key={feature} titleId="standard-feature-title" onClose={() => setFeature('')}><button className="standard-close" aria-label="关闭功能说明" onClick={() => setFeature('')}><X size={19}/></button>
        {feature === '设置与版本' ? <><span className="standard-section-icon"><Settings size={24}/></span><h2 id="standard-feature-title">本机资料与版本</h2><p>WeChatAuto · 普通开源版</p><dl className="standard-settings-list"><div><dt><Monitor size={16}/>当前连接</dt><dd>{snapshot.connected ? snapshot.accountName || '微信已连接' : '尚未连接'}</dd></div><div><dt><ShieldCheck size={16}/>资料范围</dt><dd>在本机读取与导出</dd></div><div><dt><FolderOpen size={16}/>保存位置</dt><dd>开始导出时选择</dd></div></dl><button className="primary" onClick={() => { setFeature(''); setMode('export') }}><SlidersHorizontal size={17}/>打开导出设置</button>{snapshot.connected && <button onClick={() => void run(async () => { setSnapshot(await api.lock()); setFeature('') })}><Unplug size={16}/>断开微信</button>}</>
          : <><span className="standard-section-icon"><Sparkles size={24}/></span><span className="standard-eyebrow">极客版功能</span><h2 id="standard-feature-title">{feature}</h2><p>在极客版中使用自动回复，让 AI 结合上下文自然接话。</p><ul className="standard-feature-list"><li><MessageCircle size={17}/>自动回复与逐条引用</li><li><Bot size={17}/>模型与回复风格配置</li><li><Sparkles size={17}/>人格提炼按会员权益开放</li></ul>
            <div className="standard-purchase-channels">
              <section className="standard-group standard-purchase-channel" aria-label="QQ 购买渠道">
                <button className="standard-purchase-button standard-purchase-button--qq" disabled={!group.joinUrl} onClick={() => void run(() => api.openGroup('qq'))}><PurchaseChannelIcon channel="qq"/><span>加入 QQ 群购买</span><ExternalLink size={16}/></button>
                <strong>{group.groupName ? `QQ 群 · ${group.groupName}` : 'QQ 购买群'}</strong>
                <div className="standard-group-number"><span>{group.groupNumber ? `群号：${group.groupNumber}` : 'QQ 群号待配置'}</span><button disabled={!group.groupNumber} aria-label="复制群号" onClick={() => void run(async () => { setGroupCopied(false); await api.copyGroupNumber(); setGroupCopied(true) })}>{groupCopied ? <CheckCircle2 size={14}/> : <Copy size={14}/>}<span>{groupCopied ? '已复制' : '复制群号'}</span></button></div>
              </section>
              <section className="standard-group standard-purchase-channel" aria-label="Telegram 购买渠道">
                <button className="standard-purchase-button standard-purchase-button--telegram" disabled={!group.telegramUrl} onClick={() => void run(() => api.openGroup('telegram'))}><PurchaseChannelIcon channel="telegram"/><span>加入 Telegram 群购买</span><ExternalLink size={16}/></button>
                <strong>Telegram 购买群</strong>
                <span className="standard-telegram-hint">前往 Telegram 加入群组，联系管理员购买。</span>
              </section>
            </div>
            <p className="standard-purchase-feedback" role="status">{groupCopied ? '已复制，可在 QQ 中搜索群号添加。' : 'QQ 链接无法打开时，可复制群号在 QQ 中搜索添加。'}</p>
            {error && <p className="standard-error" role="alert"><CircleAlert size={16}/><span>{error}</span><ErrorLogAction error={error} source="standard.operation"/></p>}
            <button onClick={() => { setFeature(''); setMode('export') }}><ArrowLeft size={16}/>返回消息导出</button></>}
      </Dialog>
      : sessionInfo ? <Dialog key="session-info" titleId="standard-session-info-title" onClose={() => setSessionInfo(undefined)}><button className="standard-close" aria-label="关闭会话信息" onClick={() => setSessionInfo(undefined)}><X size={19}/></button><span className="standard-section-icon"><Info size={24}/></span><h2 id="standard-session-info-title">会话信息</h2><dl className="standard-session-info"><div><dt>名称</dt><dd>{sessionInfo.name}</dd></div><div><dt>账号标识</dt><dd>{sessionInfo.id}</dd></div><div><dt>最近消息</dt><dd>{sessionInfo.preview || '暂无消息摘要'}</dd></div></dl></Dialog>
      : preview ? <Dialog key="image-preview" titleId="standard-image-title" className="standard-preview-modal" onClose={() => setPreview('')}><header><h2 id="standard-image-title">聊天图片</h2><button aria-label="关闭图片预览" onClick={() => setPreview('')}><X size={19}/></button></header><img className="standard-image-preview" src={preview} alt="聊天图片"/></Dialog>
      : mediaPreview ? <Dialog key="media-preview" titleId="standard-media-title" className="standard-preview-modal" onClose={() => setMediaPreview(undefined)}><header><h2 id="standard-media-title">{mediaPreview.kind === 'audio' ? '语音' : '视频'}</h2><button aria-label="关闭媒体预览" onClick={() => setMediaPreview(undefined)}><X size={19}/></button></header>{mediaPreview.kind === 'audio' ? <audio controls autoPlay src={mediaPreview.url}/> : <video controls autoPlay src={mediaPreview.url}/>}</Dialog> : null}
  </div>
}
