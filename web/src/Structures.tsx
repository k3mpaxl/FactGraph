import { useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Boxes, ChevronDown, ChevronRight, CornerDownLeft, Crosshair, Pencil, Plus, Search, Ungroup, X, Zap } from 'lucide-react'
import type { ActionDraft } from './board'
import type { Fact, GraphData, Group, Participant } from './types'
import { uuid } from './uuid'

export const ROLES = ['actor', 'identity', 'source', 'tool', 'via', 'target', 'other']
export const roleHint: Record<string, string> = {
  actor: 'Who acts (threat actor, user)', identity: 'Identity used (service principal, account)', source: 'Where it came from (IP, device)',
  tool: 'Tool or process used', via: 'Intermediate system', target: 'What was acted on', other: 'Other participant',
}
type Select = (selection: { kind: 'entity' | 'fact' | 'group'; id: string } | null, focus?: boolean) => void

function nameOf(data: GraphData, id: string) { return data.entities.find(e => e.id === id)?.name ?? 'Unknown' }
function entityOptions(data: GraphData) {
  return [...data.entities].sort((a, b) => a.name.localeCompare(b.name)).map(e => <option key={e.id} value={e.id}>{e.name} · {e.kind}</option>)
}

function Collapsible({ title, count, action, children, open: initial = true }: { title: string; count?: number; action?: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return <section className="inspector-section">
    <div className="section-heading"><button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<h3>{title}</h3>{count !== undefined && <span className="count">{count}</span>}</button>{action}</div>
    {open && <div className="section-body">{children}</div>}
  </section>
}

/** Group details: membership, rule, exceptions and the connections the group bundles. */
export function GroupInspector({ data, group, onCommand, onSelect, onFocus, onClose }: {
  data: GraphData; group: Group; onCommand: (drafts: ActionDraft[]) => Promise<unknown>; onSelect: Select; onFocus: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [ruleEdit, setRuleEdit] = useState<{ kinds: string; match: string } | null>(null)
  const members = useMemo(() => new Set(group.member_ids), [group.member_ids])
  const byId = useMemo(() => new Map(data.entities.map(e => [e.id, e])), [data.entities])
  const degree = useMemo(() => { const m = new Map<string, number>(); for (const f of data.facts) { m.set(f.subject_id, (m.get(f.subject_id) ?? 0) + 1); m.set(f.object_id, (m.get(f.object_id) ?? 0) + 1) } return m }, [data.facts])
  const connections = useMemo(() => {
    const counts = new Map<string, { out: boolean; predicate: string; other: string; count: number }>()
    for (const f of data.facts) {
      const s = members.has(f.subject_id), o = members.has(f.object_id)
      if (s === o) continue
      const key = `${s ? 'o' : 'i'}|${f.predicate}|${s ? f.object_id : f.subject_id}`
      const item = counts.get(key)
      if (item) item.count++; else counts.set(key, { out: s, predicate: f.predicate, other: s ? f.object_id : f.subject_id, count: 1 })
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12)
  }, [data.facts, members])
  const needle = query.trim().toLowerCase()
  const list = useMemo(() => group.member_ids.map(id => byId.get(id)!).filter(e => e && (!needle || `${e.name} ${e.kind}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [group.member_ids, byId, needle])
  const run = (drafts: ActionDraft[]) => void onCommand(drafts).catch(() => {})
  const container = group.rule?.container_id ? byId.get(group.rule.container_id) : undefined
  return <aside className="inspector" aria-label="Inspector">
    <div className="inspector-head"><span className="eyebrow">{container ? 'Contents' : 'Group'}</span><div className="head-actions">
      <button className="icon-button" onClick={onClose} aria-label="Close" title="Close · Esc"><X size={16} /></button></div></div>
    <div className="inspector-scroll">
      <div className="inspector-title"><span className="entity-avatar lg group-avatar"><Boxes size={18} /></span><div><h2>{group.name}</h2>
        <span className="kind-label">{group.member_ids.length} members · {container ? `inside ${container.name}` : group.rule ? 'rule-based' : 'manual'}{group.collapsed ? ' · collapsed' : ''}</span></div></div>
      <div className="inspector-actions">
        <button className="primary-button small" onClick={() => { const expand = group.collapsed; void onCommand([{ type: 'group.update', payload: { id: group.id, collapsed: !expand } }]).then(() => onFocus(group.id)).catch(() => {}) }}>{group.collapsed ? 'Expand' : 'Collapse'}</button>
        <button className="secondary-button small" onClick={() => { const name = window.prompt('Group name', group.name); if (name?.trim()) run([{ type: 'group.update', payload: { id: group.id, name: name.trim() } }]) }}><Pencil size={14} /> Rename</button>
        <button className="secondary-button small icon-only" title="Center in graph" aria-label="Center group" onClick={() => onFocus(group.id)}><Crosshair size={14} /></button>
      </div>
      <p className="inspector-note plain">A group bundles entities on the canvas. Relationships and evidence of its members are unchanged; edges show how many members they stand for.</p>
      {!container && <Collapsible title="Rule" action={<button className="text-button" onClick={() => setRuleEdit(ruleEdit ? null : { kinds: group.rule?.kinds?.join(', ') ?? '', match: group.rule?.match ?? '' })}>{ruleEdit ? 'Cancel' : 'Edit'}</button>}>
        {ruleEdit ? <form className="stack" onSubmit={e => { e.preventDefault(); const kinds = ruleEdit.kinds.split(',').map(k => k.trim()).filter(Boolean); run([{ type: 'group.update', payload: { id: group.id, rule: kinds.length || ruleEdit.match.trim() ? { kinds, match: ruleEdit.match.trim() } : null } }]); setRuleEdit(null) }}>
          <label>Types <span className="optional">comma separated</span><input value={ruleEdit.kinds} onChange={e => setRuleEdit({ ...ruleEdit, kinds: e.target.value })} placeholder="Repository" list="group-kinds" /></label>
          <datalist id="group-kinds">{[...new Set(data.entities.map(e => e.kind))].map(k => <option key={k}>{k}</option>)}</datalist>
          <label>Name or identifier contains <span className="optional">optional</span><input value={ruleEdit.match} onChange={e => setRuleEdit({ ...ruleEdit, match: e.target.value })} placeholder="org-x/" /></label>
          <div className="form-row-end"><span className="hint">Matching entities join automatically, also from later imports.</span><button className="primary-button small">Save rule</button></div>
        </form> : group.rule ? <p className="small">{group.rule.kinds?.length ? <>Type is <strong>{group.rule.kinds.join(' or ')}</strong></> : 'Any type'}{group.rule.match ? <> and name contains <code>{group.rule.match}</code></> : null}. New matches join automatically.</p>
          : <p className="muted small">Manual membership ({group.members.length}). Add a rule to include future entities automatically.</p>}
      </Collapsible>}
      {group.excluded.length > 0 && <Collapsible title="Kept separate" count={group.excluded.length}>
        {group.excluded.map(id => byId.get(id)).filter(Boolean).map(e => <div key={e!.id} className="member-row">
          <button className="member-name" onClick={() => onSelect({ kind: 'entity', id: e!.id }, true)}>{e!.name}</button><span className="member-kind">{e!.kind}</span>
          <button className="text-button" onClick={() => run([{ type: 'group.update', payload: { id: group.id, include: [e!.id] } }])}>Put back</button></div>)}
      </Collapsible>}
      {connections.length > 0 && <Collapsible title="Bundled connections" count={connections.length}>
        {connections.map(c => <div key={`${c.out}${c.predicate}${c.other}`} className="relation-row">
          <span className="relation-main"><span className="relation-dir">{c.out ? <ArrowRight size={13} /> : <ArrowLeft size={13} />}</span><span className="relation-predicate">{c.predicate}</span><b className="count">×{c.count}</b></span>
          <button className="relation-target" onClick={() => onSelect({ kind: 'entity', id: c.other }, true)}>{nameOf(data, c.other)}</button></div>)}
      </Collapsible>}
      <Collapsible title="Members" count={group.member_ids.length}>
        <label className="input-with-icon"><Search size={14} /><input placeholder="Filter members…" value={query} onChange={e => { setQuery(e.target.value); setLimit(100) }} aria-label="Filter members" /></label>
        <div className="member-list">{list.slice(0, limit).map(e => <div key={e.id} className="member-row">
          <button className="member-name" onClick={() => onSelect({ kind: 'entity', id: e.id }, !group.collapsed)} title={e.name}>{e.name}</button>
          <span className="member-kind">{degree.get(e.id) ?? 0}</span>
          <button className="row-delete" title="Take out of group — show separately" aria-label={`Take ${e.name} out of group`} onClick={() => run([{ type: 'group.update', payload: { id: group.id, exclude: [e.id] } }])}><Ungroup size={12} /></button>
        </div>)}</div>
        {list.length > limit && <button className="explorer-more" onClick={() => setLimit(limit + 200)}>Show more ({list.length - limit})</button>}
      </Collapsible>
    </div>
    <div className="inspector-foot"><button className="danger-link" onClick={() => { onSelect(null); run([{ type: 'group.delete', payload: { id: group.id } }]) }}><Ungroup size={14} /> Ungroup · entities stay</button></div>
  </aside>
}

/** Role-tagged participants of an activity, editable in place. */
export function ParticipantList({ data, fact, onCommand, onSelect }: { data: GraphData; fact: Fact; onCommand: (drafts: ActionDraft[]) => Promise<unknown>; onSelect: Select }) {
  const [adding, setAdding] = useState<{ entity_id: string; role: string } | null>(null)
  const [error, setError] = useState('')
  const participants = fact.participants ?? []
  const save = (next: Participant[]) => { setError(''); void onCommand([{ type: 'fact.update', payload: { id: fact.id, participants: next } }]).then(() => setAdding(null)).catch(e => setError(String(e))) }
  const order = (p: Participant) => { const i = ROLES.indexOf(p.role); return i < 0 ? ROLES.length : i }
  return <div className="participant-list">
    {[...participants].sort((a, b) => order(a) - order(b)).map(p => <div key={`${p.role}:${p.entity_id}`} className="participant-row">
      <span className={`role-badge ${p.role}`} title={roleHint[p.role]}>{p.role}</span>
      <button className="relation-target left" onClick={() => onSelect({ kind: 'entity', id: p.entity_id }, true)}>{nameOf(data, p.entity_id)}</button>
      {participants.length > 2 && <button className="row-delete" aria-label={`Remove ${p.role}`} title="Remove participant" onClick={() => save(participants.filter(x => x !== p))}><X size={12} /></button>}
    </div>)}
    {adding ? <form className="participant-add" onSubmit={e => { e.preventDefault(); if (adding.entity_id) save([...participants, adding]) }}>
      <select aria-label="Participant role" value={adding.role} onChange={e => setAdding({ ...adding, role: e.target.value })}>{ROLES.map(r => <option key={r}>{r}</option>)}</select>
      <select aria-label="Participant entity" value={adding.entity_id} required onChange={e => setAdding({ ...adding, entity_id: e.target.value })}><option value="" disabled>Entity…</option>{entityOptions(data)}</select>
      <button className="primary-button small" aria-label="Add participant"><CornerDownLeft size={13} /></button>
    </form> : <button className="text-button" onClick={() => setAdding({ entity_id: '', role: 'via' })}><Plus size={14} /> Add participant</button>}
    {error && <div className="form-error">{error}</div>}
  </div>
}

/** One observed event with several participants, e.g. attacker used IP A and SP B to list Key Vault C. */
export function ActivityDialog({ data, initialEntity, onClose, onCommand, onCreated }: {
  data: GraphData; initialEntity?: string; onClose: () => void; onCommand: (drafts: ActionDraft[]) => Promise<unknown>; onCreated: (id: string) => void;
}) {
  const [rows, setRows] = useState<Participant[]>(() => initialEntity ? [{ role: 'actor', entity_id: initialEntity }, { role: 'target', entity_id: '' }] : [{ role: 'actor', entity_id: '' }, { role: 'identity', entity_id: '' }, { role: 'target', entity_id: '' }])
  const [stance, setStance] = useState<'supports' | 'refutes'>('supports')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const get = (field: string) => String(form.get(field) ?? '').trim()
    const asDate = (field: string) => get(field) ? new Date(get(field)).toISOString() : null
    const participants = rows.filter(r => r.entity_id)
    if (new Set(participants.map(p => p.entity_id)).size < 2) { setError('Choose at least two different participants.'); return }
    if (get('valid_from') && get('valid_to') && get('valid_from') > get('valid_to')) { setError('The end must be after the start.'); return }
    const id = uuid()
    const created_at = new Date().toISOString()
    const drafts: ActionDraft[] = [{ type: 'fact.add', payload: { id, predicate: get('predicate'), participants, technique: get('technique'), valid_from: asDate('valid_from'), valid_to: asDate('valid_to'), created_at } }]
    if (get('observation') || get('source_id') || get('locator'))
      drafts.push({ type: 'assertion.add', payload: { id: uuid(), fact_id: id, stance, confidence: Number(get('confidence') || 100) / 100, source_id: get('source_id') || null, observation: get('observation'), note: get('observation'), locator: get('locator'), valid_from: asDate('valid_from'), valid_to: asDate('valid_to'), created_at } })
    setBusy(true); setError('')
    try { await onCommand(drafts); onCreated(id) } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="New activity">
      <div className="modal-header"><h2><Zap size={15} className="title-icon" /> New activity</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <form onSubmit={e => void submit(e)}>
        <div className="modal-body">
          <p className="hint">One observed event with several participants — e.g. <em>attacker used IP a.a.a.a and service principal B and listed Key Vault C</em>. Evidence attaches to the whole event.</p>
          <div className="field-grid"><label>Operation<input name="predicate" required autoFocus placeholder="listed secrets, signed in, read blob…" /></label>
            <label>ATT&CK technique <span className="optional">optional</span><input name="technique" placeholder="T1555.006" /></label></div>
          <div className="stack participant-editor">
            <span className="field-label">Participants</span>
            {rows.map((row, index) => <div key={index} className="participant-edit-row">
              <select aria-label={`Role ${index + 1}`} value={row.role} onChange={e => setRows(rows.map((r, i) => i === index ? { ...r, role: e.target.value } : r))} title={roleHint[row.role]}>{ROLES.map(r => <option key={r}>{r}</option>)}</select>
              <select aria-label={`Participant ${index + 1}`} value={row.entity_id} onChange={e => setRows(rows.map((r, i) => i === index ? { ...r, entity_id: e.target.value } : r))}><option value="">Choose entity…</option>{entityOptions(data)}</select>
              <button type="button" className="icon-button" aria-label="Remove row" disabled={rows.length <= 2} onClick={() => setRows(rows.filter((_, i) => i !== index))}><X size={14} /></button>
            </div>)}
            <button type="button" className="text-button" onClick={() => setRows([...rows, { role: 'via', entity_id: '' }])}><Plus size={14} /> Add participant</button>
          </div>
          <div className="field-grid"><label>Activity from <span className="optional">UTC</span><input name="valid_from" type="datetime-local" step="1" /></label><label>Activity to <span className="optional">optional</span><input name="valid_to" type="datetime-local" step="1" /></label></div>
          <div className="form-divider">Evidence</div>
          <div className="stance-field"><span>Evidence stance</span><div className="segmented"><button type="button" className={stance === 'supports' ? 'active supports' : ''} onClick={() => setStance('supports')}>Supports</button><button type="button" className={stance === 'refutes' ? 'active refutes' : ''} onClick={() => setStance('refutes')}>Refutes</button></div></div>
          <div className="field-grid"><label>Source <span className="optional">optional</span><select name="source_id" defaultValue=""><option value="">Manual entry</option>{data.sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
            <label>Confidence <span className="optional">0–100 %</span><input name="confidence" type="number" min="0" max="100" defaultValue={100} /></label></div>
          <label>Locator / event ID<input name="locator" placeholder="CorrelationId, result row…" /></label>
          <label>Observation<textarea name="observation" rows={2} placeholder="What does the log record show?" /></label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Create activity'} <CornerDownLeft size={14} /></button></div>
      </form>
    </div>
  </div>
}
