import { Check, Copy } from 'lucide-react'
import type { ActionDraft } from './board'
import type { GraphData } from './types'
import { GAP_URI, inventoryRecords, type Gap, type GapReport } from './gaps'

type Command = (drafts: ActionDraft[]) => Promise<unknown>
const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`
const PLATFORM = { defender: 'Defender XDR advanced hunting', sentinel: 'Sentinel / Log Analytics' }

/** "Nothing found" is an answer too: the same source submit_gap_rows writes, so agents see the gap closed as well. */
export function nothingFound(gap: Gap, note = ''): ActionDraft {
  return {
    type: 'source.add',
    payload: {
      id: crypto.randomUUID(),
      title: `Answer: ${gap.question} · nothing found`.slice(0, 200),
      uri: GAP_URI + gap.id,
      excerpt: JSON.stringify({ gap: gap.id, rule: gap.rule, entities: gap.entities, rows: 0, note }),
      query: gap.query,
      source_kind: 'secondary',
    },
  }
}

/**
 * What the board still lacks, one query each (the list agents get from get_gaps). Run the query, export the result and
 * drop it on the board: the built-in mapping imports it and the gap closes. Hunts are listed under "Hunt next" once
 * something is marked compromised.
 */
export function GapList({
  data,
  report,
  hunts,
  onCommand,
  onShow,
  onCopy,
}: {
  data: GraphData
  report: GapReport
  /** Hunts are shown elsewhere: leave them out here. */
  hunts: boolean
  onCommand: Command
  onShow: (entityId: string) => void
  onCopy: (value: string, label: string) => void
}) {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const open = report.gaps.filter(g => hunts || g.rule !== 'hunt')
  const elsewhere = report.gaps.length - open.length
  const records = inventoryRecords(data)
  const subject = (id: string) =>
    byId.has(id) ? (
      <button key={id} className="entity-chip" onClick={() => onShow(id)} title={`Show ${byId.get(id)!.name} in the graph`}>
        {byId.get(id)!.name}
      </button>
    ) : (
      <code key={id}>{id}</code>
    )
  return (
    <>
      <p className="hint">
        Who a user is, what a device is, which app a service principal belongs to, where a process came from and what the identities did:
        each a filled-in query. Export the result and drop it on the board; the gap closes when the rows are imported. Connected agents get
        the same list (get_gaps) and answer it with submit_gap_rows.
      </p>
      {!open.length && <p className="muted small">Nothing missing that one query would answer.</p>}
      {open.map(gap => (
        <div key={gap.id} className="hunt-query gap-item" data-gap={gap.rule}>
          <div className="hunt-head">
            <div>
              <strong>
                <span className={`advice-level ${gap.priority === 'low' ? 'info' : gap.priority}`}>{gap.priority}</span> {gap.question}
              </strong>
              <small>{gap.why}</small>
              {gap.entities.length > 0 && (
                <div className="gap-subjects">
                  {gap.entities.slice(0, 8).map(subject)}
                  {gap.entities.length > 8 && <small className="muted">+{gap.entities.length - 8} more</small>}
                </div>
              )}
              <small className="muted">
                {gap.tables.join(', ')} · {PLATFORM[gap.platform]}
              </small>
              {gap.imports_as && (
                <small className="importable-tag">Importable: export the result and drop it on the board ({gap.imports_as})</small>
              )}
            </div>
            <div className="gap-actions">
              <button className="secondary-button small" onClick={() => onCopy(gap.query, 'KQL')}>
                <Copy size={12} /> Copy
              </button>
              <button
                className="secondary-button small"
                onClick={() => void onCommand([nothingFound(gap)]).catch(() => {})}
                title="The query found nothing: close the gap for everyone on this board"
              >
                <Check size={12} /> Nothing found
              </button>
            </div>
          </div>
          <details className="query-details">
            <summary>Show query</summary>
            <pre className="code-block">{gap.query}</pre>
          </details>
        </div>
      ))}
      {elsewhere > 0 && (
        <p className="muted small">
          {elsewhere} more {elsewhere === 1 ? 'hunt' : 'hunts'} under Hunt next.
        </p>
      )}
      {(report.answered.length > 0 || records.length > 0) && (
        <details className="query-details gap-answered">
          <summary>
            Answered {report.answered.length}
            {records.length ? ` · ${records.length} inventory ${records.length === 1 ? 'export' : 'exports'}` : ''}
          </summary>
          <ul>
            {report.answered.map(answer => (
              <li key={answer.source_id}>
                <b>{answer.rule}</b> {answer.rows ? rows(answer.rows) : 'nothing found'}
                {answer.note ? ` · ${answer.note}` : ''} <span className="muted">{answer.at.slice(0, 16).replace('T', ' ')}</span>
              </li>
            ))}
            {records.map(record => (
              <li key={record.source_id}>
                <b>{record.table}</b> described {record.entities.length} {record.entities.length === 1 ? 'entity' : 'entities'} ·{' '}
                {rows(record.rows)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
