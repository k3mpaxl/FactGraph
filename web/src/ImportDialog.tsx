import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, Download, FileUp, Loader2, Trash2, Upload, X } from 'lucide-react'
import { describeTableImport, importFields, inspectImport, previewImport, uploadImport } from './importApi'
import { deleteFormat, draftFrom, exportFormats, fingerprint, formatProblems, ID_TYPES, idLabel, importFormats, loadFormats, markUsed, matchFormat, ROLE_HELP, ROLE_LABELS,
  saveFormat, setUse, useOf, usedColumns, type ColumnUse, type IdType, type ImportFormat, type Inspection, type PreviewRow } from './importFormats'
import { uuid } from './uuid'

type Item = { key: string; file: File; inspection?: Inspection; error?: string; builtin: boolean; draft: string | null }
/** A format being edited; files with the same columns, or recognised by the same saved format, share one. */
type Draft = { format: ImportFormat; savedId: string | null; remember: boolean; dirty: boolean }
type Checked = Record<string, { result?: Record<string, unknown>; error?: string }>

const USES: { use: ColumnUse['use']; label: string }[] = [
  { use: 'ignore', label: '— not used' }, { use: 'entity', label: 'Entity' }, { use: 'id', label: 'ID of an entity' },
  { use: 'time', label: 'Event time' }, { use: 'end', label: 'End time' }, { use: 'operation', label: 'What happened' },
  { use: 'detail', label: 'Detail for the evidence' }, { use: 'locator', label: 'Row ID' },
]
/** A first guess of the entity type from what the values look like. */
const KIND_OF_TYPE: Record<string, string> = { ip: 'IP', email: 'User', url: 'URL', domain: 'Domain', file: 'File', path: 'File', guid: 'Other' }
const utcText = (value: string | null) => value ? `${value.slice(0, 19).replace('T', ' ')} UTC` : 'no time'
const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/**
 * Import logs and exports. Every file is read first (columns, sample values, built-in table). Defender XDR and Sentinel
 * tables have a built-in format; files with columns of a saved format use it; anything else is mapped column by column,
 * with a live preview of the first rows, and the mapping is saved as a format for the next export of the same kind.
 */
export default function ImportDialog({ boardId, sessionToken, kinds, initial, onClose, onApply }: {
  boardId: string; sessionToken: string; kinds: string[]
  /** Files dropped on the board that need a mapping, already read. */
  initial?: { file: File; inspection?: Inspection }[]
  onClose: () => void
  /** Runs the imports in the background (one after another, each with a notification); the dialog closes at once. */
  onApply: (jobs: { name: string; run: () => Promise<string> }[]) => void
}) {
  const [state, setState] = useState<{ items: Item[]; drafts: Record<string, Draft> }>({ items: [], drafts: {} })
  const { items, drafts } = state
  const [saved, setSaved] = useState(loadFormats)
  const savedRef = useRef(saved)
  savedRef.current = saved
  const [selected, setSelected] = useState<string | null>(null)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [manage, setManage] = useState(false)
  const formatFile = useRef<HTMLInputElement>(null)

  /** Which format a freshly read file uses: a saved format that fits, the built-in table, or a new one from the suggestion. */
  const assign = (key: string, inspection: Inspection) => setState(current => {
    const columns = inspection.columns.map(c => c.name)
    const drafts = { ...current.drafts }
    let draft: string | null = null
    const match = matchFormat(savedRef.current, columns)
    if (match) {
      draft = `saved:${match.format.id}`
      drafts[draft] ??= { format: match.format, savedId: match.format.id, remember: true, dirty: false }
    } else if (!inspection.builtin) {
      draft = `new:${fingerprint(columns)}`
      drafts[draft] ??= { format: draftFrom(inspection.suggestion, inspection.file, columns), savedId: null, remember: true, dirty: true }
    }
    const items = current.items.map(item => item.key === key ? { ...item, inspection, builtin: !match && !!inspection.builtin, draft } : item)
    return { items, drafts }
  })

  const addFiles = (entries: { file: File; inspection?: Inspection }[]) => {
    const fresh = entries.map(entry => ({ key: uuid(), file: entry.file, inspection: undefined as Inspection | undefined, builtin: false, draft: null as string | null }))
    setState(current => ({ ...current, items: [...current.items, ...fresh] }))
    setChecked(null)
    fresh.forEach((item, index) => {
      const known = entries[index].inspection
      void (known ? Promise.resolve(known) : inspectImport(boardId, sessionToken, item.file)).then(inspection => assign(item.key, inspection),
        problem => setState(current => ({ ...current, items: current.items.map(i => i.key === item.key ? { ...i, error: message(problem) } : i) })))
    })
  }
  // Files dropped on the board while the dialog is open are added to it.
  const taken = useRef(new Set<File>())
  useEffect(() => {
    const fresh = (initial ?? []).filter(entry => !taken.current.has(entry.file))
    fresh.forEach(entry => taken.current.add(entry.file))
    if (fresh.length) addFiles(fresh)
  }, [initial]) // eslint-disable-line react-hooks/exhaustive-deps

  // The file shown in the mapping: the chosen one, else the first that needs a mapping, else the first.
  const needsWork = (item: Item) => !!item.draft && (!drafts[item.draft]?.savedId || drafts[item.draft].dirty || formatProblems(drafts[item.draft].format).length > 0)
  const current = items.find(i => i.key === selected) ?? items.find(i => i.inspection && needsWork(i)) ?? items.find(i => i.inspection) ?? null
  const draft = current?.draft ? drafts[current.draft] : undefined
  const format = draft?.format

  const editDraft = (key: string, change: (format: ImportFormat) => ImportFormat) => {
    setState(s => ({ ...s, drafts: { ...s.drafts, [key]: { ...s.drafts[key], format: change(s.drafts[key].format), dirty: true } } }))
    setChecked(null)
  }
  const choose = (item: Item, choice: string) => {
    setChecked(null)
    if (choice === 'builtin') { setState(s => ({ ...s, items: s.items.map(i => i.key === item.key ? { ...i, builtin: true, draft: null } : i) })); return }
    setState(s => {
      const inspection = item.inspection!
      const columns = inspection.columns.map(c => c.name)
      const drafts = { ...s.drafts }
      let key: string
      if (choice === 'new') {
        key = `new:${fingerprint(columns)}`
        drafts[key] ??= { format: draftFrom(inspection.suggestion, inspection.file, columns), savedId: null, remember: true, dirty: true }
      } else {
        const chosen = saved.find(f => f.id === choice)!
        key = `saved:${chosen.id}`
        drafts[key] ??= { format: chosen, savedId: chosen.id, remember: true, dirty: false }
      }
      return { items: s.items.map(i => i.key === item.key ? { ...i, builtin: false, draft: key } : i), drafts }
    })
  }

  // Live preview of the first rows, computed by the server with the same code as the import.
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; error?: string } | null>(null)
  const problems = format ? formatProblems(format) : []
  useEffect(() => {
    setPreview(null)
    if (!format || !current?.inspection || problems.length) return
    let stale = false
    const timer = window.setTimeout(() => {
      void previewImport(boardId, sessionToken, current.inspection!.sample, format).then(result => { if (!stale) setPreview({ rows: result.rows }) },
        problem => { if (!stale) setPreview({ rows: [], error: message(problem) }) })
    }, 250)
    return () => { stale = true; window.clearTimeout(timer) }
  }, [format, current?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = items.filter(i => i.inspection && !i.error)
  const blocked = ready.filter(i => i.draft && formatProblems(drafts[i.draft].format).length)
  const formatOf = (item: Item) => item.draft ? drafts[item.draft].format : null

  const check = async () => {
    setBusy(true); setError('')
    const results: Checked = {}
    try {
      for (const item of ready) {
        try { results[item.key] = { result: await uploadImport(boardId, sessionToken, item.file, { ...importFields(formatOf(item)), title, query, dry_run: 'true' }) } }
        catch (problem) { results[item.key] = { error: message(problem) } }
      }
      setChecked(results)
      if (Object.values(results).every(r => r.error)) setError(ready.length === 1 ? Object.values(results)[0].error! : 'None of the files can be imported like this.')
    } finally { setBusy(false) }
  }
  const apply = () => {
    // Formats are remembered before the import starts, so the next export of the same kind is recognised.
    const stored = new Map<string, ImportFormat>()
    let formats = saved
    for (const [key, d] of Object.entries(drafts)) {
      if (!items.some(i => i.draft === key)) continue
      if (d.remember && (d.dirty || !d.savedId)) { const result = saveFormat({ ...d.format, id: d.savedId ?? '' }); formats = result.formats; stored.set(key, result.saved) }
      else stored.set(key, d.format)
    }
    formats = markUsed([...stored.values()].map(f => f.id).filter(Boolean))
    setSaved(formats)
    const good = ready.filter(i => checked?.[i.key]?.result)
    onApply(good.map(item => ({ name: item.file.name, run: async () => describeTableImport(await uploadImport(boardId, sessionToken, item.file,
      { ...importFields(item.draft ? stored.get(item.draft)! : null), title, query, dry_run: 'false' })) })))
    onClose()
  }
  const importable = ready.filter(i => checked?.[i.key]?.result).length
  const reading = items.filter(i => !i.inspection && !i.error).length

  const kindOptions = useMemo(() => [...new Set([...kinds, ...saved.flatMap(f => f.entities.map(e => e.kind))])].sort((a, b) => a.localeCompare(b, 'en')), [kinds, saved])
  const sampleOf = (column: string) => current?.inspection?.columns.find(c => c.name === column)

  const changeUse = (column: string, use: ColumnUse['use']) => {
    if (!current?.draft || !format) return
    const profile = sampleOf(column)
    // What the board knows about the values decides first, then what they look like.
    const known = profile?.known
    const roles = new Set(format.entities.map(e => e.role))
    const kind = known?.kind ?? KIND_OF_TYPE[profile?.type ?? ''] ?? 'Other'
    const ownId = known?.id_type && !['email', 'ip', 'fqdn'].includes(known.id_type) ? { column, type: known.id_type, namespace: known.namespace || undefined } : null
    const next: ColumnUse = use === 'entity' ? { use, kind, own: ownId, role: kind === 'IP' ? (roles.has('source') ? 'target' : 'source') : kind === 'User' && !roles.has('actor') ? 'actor'
        : (kind === 'Service Principal' || kind === 'Managed Identity') && !roles.has('identity') ? 'identity' : 'target' }
      : use === 'id' ? { use, of: format.entities.find(e => known && e.kind === known.kind)?.column ?? format.entities[0]?.column ?? '', namespace: known?.namespace || undefined,
          type: known?.id_type ?? (profile?.type === 'guid' ? 'entra-object-id' : profile?.type === 'sha256' || profile?.type === 'sha1' || profile?.type === 'md5' ? profile.type as IdType : 'other') }
      : use === 'detail' ? { use, label: '' } : { use } as ColumnUse
    editDraft(current.draft, f => setUse(f, column, next))
  }

  const supported = (files: File[]) => files.filter(file => /\.(csv|tsv|json|jsonl|ndjson)$/i.test(file.name))
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); const files = supported([...event.dataTransfer.files]); if (files.length) addFiles(files.map(file => ({ file }))) }}>
    <div className="modal import-modal" role="dialog" aria-modal="true" aria-label="Import logs and exports">
      <div className="modal-header"><h2>Import logs and exports</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <div className="modal-body">
        <p className="hint">CSV, JSON or JSONL, up to 20 MB and 50,000 rows per file. Defender XDR and Sentinel tables are recognised by their columns. For any other export, say once what its columns are; FactGraph remembers this as a <b>format</b> and recognises the next export of the same kind, also when you drop it on the board.</p>
        <label className="file-pick"><FileUp size={16} /><span>{items.length ? 'Add files' : 'Choose files'}</span>
          <input aria-label="Files" type="file" multiple accept=".csv,.tsv,.json,.jsonl,.ndjson" onChange={event => { addFiles([...(event.target.files ?? [])].map(file => ({ file }))); event.target.value = '' }} /></label>

        {items.length > 0 && <ul className="import-file-list" aria-label="Files to import">{items.map(item => {
          const d = item.draft ? drafts[item.draft] : undefined
          const result = checked?.[item.key]
          const status = item.error ? <span className="bad">{item.error}</span>
            : !item.inspection ? <span className="muted"><Loader2 size={12} className="spin" /> Reading…</span>
            : item.builtin ? <span className="ok"><Check size={12} /> Built-in: {item.inspection.builtin!.table}{item.inspection.builtin!.product ? ` (${item.inspection.builtin!.product})` : ''}</span>
            : d && formatProblems(d.format).length ? <span className="warn"><AlertTriangle size={12} /> Map its columns</span>
            : d?.savedId ? <span className="ok"><Check size={12} /> Format: {d.format.name}{d.dirty ? ' (changed)' : ''}</span>
            : <span className="ok"><Check size={12} /> New format: {d?.format.name}</span>
          return <li key={item.key} className={current?.key === item.key ? 'active' : ''}>
            <button type="button" onClick={() => setSelected(item.key)} disabled={!item.inspection} aria-label={`Show mapping of ${item.file.name}`}>
              <span className="file-name">{item.file.name}</span>
              <small>{item.inspection ? `${item.inspection.rows.toLocaleString('en')} rows · ${item.inspection.columns.length} columns` : ''}</small>
              {status}</button>
            {result?.result && <small className="check-result">{describeTableImport(result.result)}{result.result.time_field ? ` · time from ${String(result.result.time_field)}` : ' · no time column'}{Number(result.result.undated ?? 0) ? ` · ${String(result.result.undated)} rows without a time` : ''}</small>}
            {result?.error && <small className="check-result bad">{result.error}</small>}
            <button type="button" className="icon-button" aria-label={`Remove ${item.file.name}`} onClick={() => { setState(s => ({ ...s, items: s.items.filter(i => i.key !== item.key) })); setChecked(null) }}><X size={13} /></button>
          </li>
        })}</ul>}

        {current?.inspection && <section className="mapping" aria-label={`Mapping of ${current.file.name}`}>
          <div className="mapping-head">
            <label>Format of {current.file.name}
              <select aria-label="Format" value={current.builtin ? 'builtin' : draft?.savedId ?? 'new'} onChange={event => choose(current, event.target.value)}>
                {current.inspection.builtin && <option value="builtin">Built-in: {current.inspection.builtin.table}</option>}
                <option value="new">New format from this file</option>
                {saved.map(f => { const fits = usedColumns(f).every(c => current.inspection!.columns.some(col => col.name === c))
                  return <option key={f.id} value={f.id} disabled={!fits}>{f.name}{fits ? '' : ' (columns missing)'}</option> })}
              </select></label>
            {format && <label>Name<input aria-label="Format name" value={format.name} maxLength={120} placeholder="e.g. Key Vault diagnostics" onChange={event => editDraft(current.draft!, f => ({ ...f, name: event.target.value }))} /></label>}
          </div>

          {current.builtin ? <div className="builtin-summary">
            <p><b>{current.inspection.builtin!.table}</b>{current.inspection.builtin!.product ? ` (${current.inspection.builtin!.product})` : ''} has a built-in format{current.inspection.builtin!.known_columns ? `: ${current.inspection.builtin!.known_columns} of ${current.inspection.builtin!.total_columns} columns are known` : ''}. Devices, accounts, files and apps are matched by their IDs with what is already on the board.</p>
            {!!current.inspection.builtin!.roles?.length && <ul>{current.inspection.builtin!.roles!.map(r => <li key={`${r.field}-${r.role}`}><code>{r.field}</code> → {r.kind}, {r.role}{r.identifiers?.length ? ` · IDs ${r.identifiers.join(', ')}` : ''}</li>)}</ul>}
            <button type="button" className="text-button" onClick={() => choose(current, 'new')}>Map the columns myself instead</button>
          </div> : format && <>
            <div className="field-stack"><span className="field-label">Each row is</span>
              <div className="segmented full" role="radiogroup" aria-label="Each row is">
                <button type="button" role="radio" aria-checked={format.rows === 'activity'} className={format.rows === 'activity' ? 'active' : ''} onClick={() => editDraft(current.draft!, f => ({ ...f, rows: 'activity', operation: f.operation === 'accessed' ? 'observed' : f.operation }))}>An event · who did what, from where, on what</button>
                <button type="button" role="radio" aria-checked={format.rows === 'relationship'} className={format.rows === 'relationship' ? 'active' : ''} onClick={() => editDraft(current.draft!, f => ({ ...f, rows: 'relationship', entities: f.entities.slice(0, 2), operation: f.operation === 'observed' ? 'related to' : f.operation }))}>A relationship · A → B, e.g. an inventory</button>
              </div></div>

            <div className="column-table" role="table" aria-label="Columns">
              <div className="column-row head" role="row"><span role="columnheader">Column</span><span role="columnheader">Values</span><span role="columnheader">Use as</span><span role="columnheader" /></div>
              {current.inspection.columns.map(column => {
                const use = useOf(format, column.name)
                const entityIndex = format.entities.findIndex(e => e.column === column.name)
                const full = format.rows === 'relationship' && format.entities.length >= 2 && entityIndex < 0
                return <div key={column.name} role="row" className={`column-row${use.use === 'ignore' ? ' unused' : ''}`}>
                  <span role="cell" className="column-name"><code>{column.name}</code>{column.type !== 'text' && column.type !== 'empty' && <span className="type-badge">{column.type}</span>}
                    {column.filled < column.of && <small>{column.filled ? `${Math.round(column.filled / column.of * 100)}% filled` : 'empty'}</small>}
                    {column.known && <span className="known-badge" title={`${column.known.matches} of ${column.known.of} distinct values are ${column.known.id_type ? `${idLabel(column.known.id_type, column.known.namespace)}s` : 'names'} of ${column.known.kind} entities already on this board`}>
                      on board: {column.known.kind}{column.known.id_type ? ` · ${idLabel(column.known.id_type, column.known.namespace)}` : ''}</span>}</span>
                  <span role="cell" className="column-samples" title={column.samples.join('\n')}>{column.samples.join(' · ') || '—'}</span>
                  <span role="cell"><select aria-label={`Use of ${column.name}`} value={use.use} onChange={event => changeUse(column.name, event.target.value as ColumnUse['use'])}>
                    {USES.map(u => <option key={u.use} value={u.use} disabled={(u.use === 'entity' && full) || (u.use === 'id' && !format.entities.some(e => e.column !== column.name))}>{u.label}</option>)}</select></span>
                  <span role="cell" className="column-extra">
                    {use.use === 'entity' && <>
                      <input aria-label={`Type of ${column.name}`} list="import-kinds" value={use.kind} placeholder="Entity type" onChange={event => editDraft(current.draft!, f => setUse(f, column.name, { ...use, kind: event.target.value }))} />
                      {(use.own || column.known?.id_type || ['guid', 'sha256', 'sha1', 'md5', 'number'].includes(column.type)) &&
                        <select aria-label={`Value of ${column.name}`} title="Is the value the entity's name, or an ID that finds it (the name then comes from the board or a later export)?"
                          value={use.own ? `${use.own.type}|${use.own.namespace ?? ''}` : 'name'}
                          onChange={event => { const [type, namespace] = event.target.value.split('|'); editDraft(current.draft!, f => setUse(f, column.name, { ...use, own: event.target.value === 'name' ? null : { column: column.name, type: type as IdType, namespace: namespace || undefined } })) }}>
                          <option value="name">is its name</option>
                          {column.known?.id_type === 'other' && column.known.namespace && <option value={`other|${column.known.namespace}`}>is {idLabel('other', column.known.namespace)}</option>}
                          {ID_TYPES.map(type => <option key={type.id} value={`${type.id}|`}>is {type.label}</option>)}</select>}
                      {format.rows === 'relationship' ? <span className="role-fixed">{entityIndex === 0 ? 'from' : 'to'}</span>
                        : <select aria-label={`Role of ${column.name}`} value={use.role} title={ROLE_HELP[use.role]} onChange={event => editDraft(current.draft!, f => setUse(f, column.name, { ...use, role: event.target.value }))}>
                          {Object.entries(ROLE_LABELS).map(([role, label]) => <option key={role} value={role} title={ROLE_HELP[role]}>{label}</option>)}</select>}
                    </>}
                    {use.use === 'id' && <>
                      <select aria-label={`Entity of ${column.name}`} value={use.of} onChange={event => editDraft(current.draft!, f => setUse(f, column.name, { ...use, of: event.target.value }))}>
                        {format.entities.filter(e => e.column !== column.name).map(e => <option key={e.column} value={e.column}>{e.column} ({e.kind})</option>)}</select>
                      <select aria-label={`ID type of ${column.name}`} value={`${use.type}|${use.namespace ?? ''}`} onChange={event => { const [type, namespace] = event.target.value.split('|'); editDraft(current.draft!, f => setUse(f, column.name, { ...use, type: type as IdType, namespace: namespace || undefined })) }}>
                        {use.namespace && <option value={`other|${use.namespace}`}>{idLabel('other', use.namespace)}</option>}
                        {ID_TYPES.map(t => <option key={t.id} value={`${t.id}|`}>{t.label}</option>)}</select>
                    </>}
                    {use.use === 'detail' && <input aria-label={`Label of ${column.name}`} value={use.label} placeholder={column.name} onChange={event => editDraft(current.draft!, f => setUse(f, column.name, { ...use, label: event.target.value }))} />}
                    {(use.use === 'time' || use.use === 'end') && <small className="muted">read as UTC unless it names a zone</small>}
                  </span>
                </div>
              })}
            </div>
            <datalist id="import-kinds">{kindOptions.map(kind => <option key={kind} value={kind} />)}</datalist>

            <label>{format.rows === 'relationship' ? 'Relationship' : format.operation_column ? `What happened when ${format.operation_column} is empty` : 'What happened (the same for every row)'}
              <input aria-label="Operation" value={format.operation} maxLength={200} placeholder={format.rows === 'relationship' ? 'e.g. stores' : 'e.g. read secret'} onChange={event => editDraft(current.draft!, f => ({ ...f, operation: event.target.value }))} /></label>

            {problems.length > 0 ? <div className="form-error" role="alert">{problems.map(p => <div key={p}>{p}</div>)}</div>
              : <div className="import-preview live"><strong>Preview · first rows of {current.file.name}</strong>
                {!preview ? <span className="muted"><Loader2 size={12} className="spin" /> Reading…</span> : preview.error ? <span className="bad">{preview.error}</span>
                  : <ul className="preview-rows">{preview.rows.slice(0, 6).map(row => <li key={row.row} className={row.skipped ? 'skipped' : ''}>
                    <span className="preview-time">{row.time ? utcText(row.time) : format.time ? 'time not readable' : 'no time'}</span>
                    <span className="preview-op">{row.operation}</span>
                    <span className="preview-parts">{row.participants.map((p, i) => { const known = current.inspection!.board_names?.[p.name.toLowerCase()]
                      return <span key={i} className={`preview-part${known ? ' known' : ''}`} title={known ? `${p.name} is the ID of ${known}, already on the board: the import adds to it` : undefined}>
                        <small>{p.role}</small> {known ?? p.name} <small>({p.kind}{known ? ', on board' : ''})</small></span> })}</span>
                    {row.details.length > 0 && <small className="muted">{row.details.join(' · ')}</small>}
                    {row.skipped && <small className="warn">skipped: {row.skipped}</small>}
                  </li>)}</ul>}
                {preview && !preview.error && preview.rows.some(r => r.skipped) && <small className="muted">{preview.rows.filter(r => r.skipped).length} of {preview.rows.length} sample rows would be skipped.</small>}
              </div>}

            {draft && <label className="check remember"><input type="checkbox" checked={draft.remember} onChange={event => setState(s => ({ ...s, drafts: { ...s.drafts, [current.draft!]: { ...s.drafts[current.draft!], remember: event.target.checked } } }))} />
              {draft.savedId ? (draft.dirty ? `Save the changes to the format “${format.name}”` : `Saved format “${format.name}”`) : 'Save as a format for future imports'}
              <small className="muted">{draft.savedId && !draft.dirty ? 'files with these columns use it automatically' : 'kept in this browser for all boards; files with these columns are then recognised'}</small></label>}
          </>}
        </section>}

        {items.length > 0 && <div className="field-grid">
          <label>Source title <span className="optional">blank = format or table and file name</span><input value={title} maxLength={200} onChange={event => { setTitle(event.target.value); setChecked(null) }} /></label>
          <label>Query <span className="optional">optional, e.g. the KQL that produced the export</span><textarea className="mono" rows={2} value={query} placeholder="AzureDiagnostics | where ResourceProvider == &quot;MICROSOFT.KEYVAULT&quot;" onChange={event => { setQuery(event.target.value); setChecked(null) }} /></label>
        </div>}

        {checked && importable > 0 && <p className="hint">Evidence parsed from the rows counts as <b>parsed by the import</b>: confirmed because the row is the original record, but not read by anyone. Nothing is saved until you import.</p>}

        <details className="saved-formats" open={manage} onToggle={event => setManage((event.target as HTMLDetailsElement).open)}>
          <summary>Saved formats ({saved.length})</summary>
          {saved.length ? <ul>{saved.map(f => <li key={f.id}><span><b>{f.name}</b> <small className="muted">{f.rows === 'relationship' ? 'relationship' : 'event'} · {f.entities.map(e => e.kind).join(', ')}{f.used_at ? ` · last used ${f.used_at.slice(0, 10)}` : ''}</small></span>
            <button type="button" className="icon-button" aria-label={`Export format ${f.name}`} title="Export as file" onClick={() => download(exportFormats([f]), `factgraph-format-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`)}><Download size={13} /></button>
            <button type="button" className="icon-button" aria-label={`Delete format ${f.name}`} onClick={() => { if (window.confirm(`Delete the format “${f.name}” from this browser?`)) setSaved(deleteFormat(f.id)) }}><Trash2 size={13} /></button></li>)}</ul>
            : <p className="hint">None yet. Formats you save here are kept in this browser for all boards.</p>}
          <div className="row">
            {saved.length > 0 && <button type="button" className="secondary-button small" onClick={() => download(exportFormats(saved), 'factgraph-import-formats.json')}><Download size={13} /> Export all</button>}
            <button type="button" className="secondary-button small" onClick={() => formatFile.current?.click()}><Upload size={13} /> Import formats…</button>
            <input ref={formatFile} type="file" accept=".json,application/json" hidden aria-label="Import formats file" onChange={event => {
              const file = event.target.files?.[0]; event.target.value = ''
              if (file) void file.text().then(text => { const result = importFormats(text); setSaved(result.formats); setError('') }).catch(problem => setError(message(problem)))
            }} />
          </div>
        </details>
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="modal-actions">
        {blocked.length > 0 && <span className="hint">Map the columns of {blocked.map(i => i.file.name).join(', ')} first</span>}
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        {checked && importable ? <button type="button" className="primary-button" onClick={apply}>{importable > 1 ? `Import ${importable} files` : 'Import'} <ArrowRight size={14} /></button>
          : <button type="button" className="primary-button" disabled={busy || !ready.length || reading > 0 || blocked.length > 0} onClick={() => void check()}>{busy ? 'Checking…' : ready.length > 1 ? `Check ${ready.length} files` : 'Check import'} <ArrowRight size={14} /></button>}
      </div>
    </div>
  </div>
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
