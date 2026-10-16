import { useState, Fragment } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FileText,
  Link2,
  CircleHelp,
  Merge,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  X,
  Crosshair,
  CheckCircle2,
  CircleDashed,
  Boxes,
  Zap,
  Ungroup,
  Braces,
  Bot,
  FileCheck2,
} from 'lucide-react'
import { addedText, reviewCounts, reviewKind, reviewText } from './provenance'
import { periodLabel, evidencePeriod } from './timeline'
import { type Selection } from './GraphView'
import { LinkedActivities, ParticipantList } from './Structures'
import { linkedActivities } from './correlation'
import { LAYERS, layerLabel, layerOf } from './layers'
import { explainTruth } from './explain'
import { CompromiseBox } from './ImpactPanel'
import { type Impact } from './impact'
import { ROW_FIELDS, rowFields, rowOf } from './rows'
import { Sentence } from './Sentence'
import { type ActionDraft } from './board'
import type { Assertion, Fact, GraphData, Identifier } from './types'
import { labels, factSpan, date, nameOf, sourceOf, EntityAvatar, StatePill, Section } from './ui'
import { DialogKind } from './Dialogs'

export function Inspector({
  data,
  selection,
  onAdd,
  onDelete,
  onRetract,
  onOpenEvidence,
  onCopy,
  onClose,
  onSelect,
  onFocus,
  onCommand,
  impact,
  onOpenImpact,
}: {
  data: GraphData
  selection: NonNullable<Selection>
  onAdd: (kind: DialogKind) => void
  onCommand: (drafts: ActionDraft[]) => Promise<unknown>
  impact: Impact | null
  onOpenImpact: () => void
  onDelete: (kind: 'entity' | 'fact' | 'identifier', id: string) => void
  onRetract: (id: string) => void
  onOpenEvidence: (id: string) => void
  onCopy: (value: string, label: string) => void
  onClose: () => void
  onSelect: (selection: Selection, focus?: boolean) => void
  onFocus: (id: string) => void
}) {
  const closeButton = (
    <button className="icon-button" onClick={onClose} aria-label="Close" title="Close · Esc">
      <X size={16} />
    </button>
  )
  if (selection.kind === 'entity') {
    const entity = data.entities.find(item => item.id === selection.id)
    if (!entity) return null
    const related = data.facts.filter(
      item => item.subject_id === entity.id || item.object_id === entity.id || item.participants?.some(p => p.entity_id === entity.id),
    )
    const group = data.groups?.find(g => g.member_ids.includes(entity.id))
    const autoLayer = layerOf({ kind: entity.kind }, data.entity_types)
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="inspector-head">
          <span className="eyebrow">Entity</span>
          <div className="head-actions">
            <button
              className="icon-button"
              title={`Copy ${entity.name}`}
              aria-label="Copy value"
              onClick={() => onCopy(entity.identifiers.find(i => i.scheme === 'ip')?.raw_value ?? entity.name, entity.kind)}
            >
              <Copy size={15} />
            </button>
            <button
              className="icon-button"
              title="Copy context for an agent (JSON)"
              aria-label="Copy context for agent"
              onClick={() => onCopy(JSON.stringify({ entity, relationships: related }, null, 2), 'Entity context')}
            >
              <Braces size={15} />
            </button>
            {closeButton}
          </div>
        </div>
        <div className="inspector-scroll">
          <div className="inspector-title">
            <EntityAvatar entity={entity} data={data} size="lg" />
            <div>
              <h2>{entity.name}</h2>
              <span className="kind-label">{entity.kind}</span>
            </div>
          </div>
          <CompromiseBox
            entity={entity}
            impact={impact}
            data={data}
            nameOf={id => nameOf(data, id)}
            onCommand={onCommand}
            onOpenImpact={onOpenImpact}
            onCopy={onCopy}
            onOpenEvidence={onOpenEvidence}
          />
          <div className="inspector-actions">
            <button className="primary-button small" onClick={() => onAdd('fact')}>
              <Link2 size={14} /> Connect
            </button>
            <button className="secondary-button small" onClick={() => onAdd('entity-edit')}>
              <Pencil size={14} /> Edit
            </button>
            <button className="secondary-button small" onClick={() => onAdd('entity-merge')}>
              <Merge size={14} /> Merge
            </button>
            <button
              className="secondary-button small icon-only"
              title="Center in graph · F"
              aria-label="Center in graph"
              onClick={() => onFocus(entity.id)}
            >
              <Crosshair size={14} />
            </button>
          </div>
          {entity.description && <p className="inspector-description">{entity.description}</p>}
          {group && (
            <div className="membership">
              <Boxes size={14} />
              <span>
                In {group.rule?.container_id ? 'contents of' : 'group'}{' '}
                <button className="link" onClick={() => onSelect({ kind: 'group', id: group.id }, true)}>
                  {group.name}
                </button>
              </span>
              <button
                className="text-button"
                onClick={() => void onCommand([{ type: 'group.update', payload: { id: group.id, exclude: [entity.id] } }]).catch(() => {})}
              >
                <Ungroup size={13} /> Take out
              </button>
            </div>
          )}
          <Section title="Relationships" count={related.length}>
            {related.length ? (
              <div className="relation-list">
                {related.map(fact => {
                  if (fact.participants?.length) {
                    const role = fact.participants.find(p => p.entity_id === entity.id)?.role ?? ''
                    const attack = impact?.facts.get(fact.id)
                    return (
                      <div
                        key={fact.id}
                        className={`relation-row${attack ? (attack.before ? ' regular' : ' attack') : ''}`}
                        title={
                          attack
                            ? `${attack.count} of ${fact.assertions.length} evidence items in the attacker window${attack.before ? '; it also happened exactly so before the compromise: likely regular' : ''}`
                            : undefined
                        }
                      >
                        <button
                          className="relation-main"
                          onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)}
                          title="Open activity"
                        >
                          <span className={`state-dot ${fact.truth_state}`} />
                          <span className="relation-dir">
                            <Zap size={13} />
                          </span>
                          <span className="relation-predicate">{fact.predicate}</span>
                          <span className="relation-time">{factSpan(fact)}</span>
                        </button>
                        <span className={`role-badge ${role}`}>{role}</span>
                      </div>
                    )
                  }
                  const outgoing = fact.subject_id === entity.id
                  const other = outgoing ? fact.object_id : fact.subject_id
                  const attack = impact?.facts.get(fact.id)
                  return (
                    <div
                      key={fact.id}
                      className={`relation-row${attack ? (attack.before ? ' regular' : ' attack') : ''}`}
                      title={attack ? `${attack.count} of ${fact.assertions.length} evidence items in the attacker window` : undefined}
                    >
                      <button
                        className="relation-main"
                        onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)}
                        title="Open relationship"
                      >
                        <span className={`state-dot ${fact.truth_state}`} title={labels[fact.truth_state]} />
                        <span className="relation-dir" title={outgoing ? 'Outgoing' : 'Incoming'}>
                          {outgoing ? <ArrowRight size={13} /> : <ArrowLeft size={13} />}
                        </span>
                        <span className="relation-predicate">{fact.predicate}</span>
                        <span className="relation-time">{factSpan(fact)}</span>
                      </button>
                      <button
                        className="relation-target"
                        onClick={() => onSelect({ kind: 'entity', id: other }, true)}
                        title="Go to entity"
                      >
                        {nameOf(data, other)}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="muted small">No relationships yet. Drag from a node's right handle to connect.</p>
            )}
          </Section>
          <Section
            title="Identifiers"
            count={entity.identifiers.length}
            action={
              <button className="text-button" onClick={() => onAdd('identifier')}>
                <Plus size={14} /> Add
              </button>
            }
          >
            {entity.identifiers.length ? (
              entity.identifiers.map(identifier => (
                <IdentifierRow
                  key={identifier.id}
                  identifier={identifier}
                  data={data}
                  onCopy={onCopy}
                  onDelete={() => onDelete('identifier', identifier.id)}
                />
              ))
            ) : (
              <p className="muted small">No identifiers yet.</p>
            )}
          </Section>
          <Section title="Details" defaultOpen={false}>
            <dl className="meta-list">
              <dt>Layer</dt>
              <dd>
                <select
                  className="inline-select"
                  aria-label="Entity layer"
                  value={entity.layer ?? ''}
                  onChange={e =>
                    void onCommand([{ type: 'entity.update', payload: { id: entity.id, layer: e.target.value || null } }]).catch(() => {})
                  }
                >
                  <option value="">Automatic · {layerLabel(autoLayer)}</option>
                  {LAYERS.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </dd>
              <dt>Created</dt>
              <dd>{date(entity.created_at)}</dd>
              <dt>Position</dt>
              <dd>{entity.pinned ? 'Pinned' : 'Free'}</dd>
              <dt>ID</dt>
              <dd>
                <button className="copy-id" onClick={() => onCopy(entity.id, 'Entity ID')} title="Copy entity ID">
                  {entity.id} <Copy size={12} />
                </button>
              </dd>
            </dl>
          </Section>
        </div>
        <div className="inspector-foot">
          <button className="danger-link" onClick={() => onDelete('entity', entity.id)}>
            <Trash2 size={14} /> Delete entity
          </button>
        </div>
      </aside>
    )
  }

  const fact = data.facts.find(item => item.id === selection.id)
  if (!fact) return null
  const active = fact.assertions.filter(a => !a.retracted_at)
  const confirmed = active.filter(a => a.review_status === 'confirmed').length
  const isActivity = !!fact.participants?.length
  const linked = linkedActivities(data, fact.id)
  return (
    <aside className="inspector wide" aria-label="Inspector">
      <div className="inspector-head">
        <span className="eyebrow">{isActivity ? 'Activity' : 'Relationship'}</span>
        <div className="head-actions">
          <button
            className="icon-button"
            title="Copy relationship ID"
            aria-label="Copy relationship ID"
            onClick={() => onCopy(fact.id, 'Relationship ID')}
          >
            <Copy size={15} />
          </button>
          {closeButton}
        </div>
      </div>
      <div className="inspector-scroll">
        {isActivity ? (
          <>
            <div className="inspector-title">
              <span className={`entity-avatar lg activity-avatar ${fact.truth_state}`}>
                <Zap size={18} />
              </span>
              <div>
                <h2>{fact.predicate}</h2>
                <span className="kind-label">
                  {fact.participants!.length} participants{fact.technique ? ` · ${fact.technique}` : ''}
                </span>
              </div>
            </div>
            <p className="activity-sentence">
              <Sentence
                fact={fact}
                data={data}
                marked={id => {
                  const m = impact?.marks.get(id)
                  return m === 'compromised' || m === 'derived'
                }}
              />
            </p>
            <div className="inspector-actions">
              <button
                className="secondary-button small"
                onClick={() => {
                  const value = window.prompt('Operation', fact.predicate)
                  if (value?.trim())
                    void onCommand([{ type: 'fact.update', payload: { id: fact.id, predicate: value.trim() } }]).catch(() => {})
                }}
              >
                <Pencil size={14} /> Operation
              </button>
              <button
                className="secondary-button small"
                onClick={() => {
                  const value = window.prompt('ATT&CK technique (empty to clear)', fact.technique ?? '')
                  if (value !== null)
                    void onCommand([{ type: 'fact.update', payload: { id: fact.id, technique: value.trim() || null } }]).catch(() => {})
                }}
              >
                Technique
              </button>
              <button
                className="secondary-button small icon-only"
                title="Center in graph"
                aria-label="Center in graph"
                onClick={() => onFocus(fact.id)}
              >
                <Crosshair size={14} />
              </button>
            </div>
            <ActivityDiagram data={data} fact={fact} onSelect={onSelect} impact={impact} />
            <Section title="Participants" count={fact.participants!.length} defaultOpen={false}>
              <ParticipantList data={data} fact={fact} onCommand={onCommand} onSelect={onSelect} />
            </Section>
          </>
        ) : (
          <div className="fact-path">
            <button onClick={() => onSelect({ kind: 'entity', id: fact.subject_id }, true)}>{nameOf(data, fact.subject_id)}</button>
            <div className={`fact-predicate ${fact.truth_state}`}>
              <span>{fact.predicate}</span>
              <ArrowDownIcon />
            </div>
            <button onClick={() => onSelect({ kind: 'entity', id: fact.object_id }, true)}>{nameOf(data, fact.object_id)}</button>
          </div>
        )}
        <div className="fact-state">
          <StatePill state={fact.truth_state} />
          <span>
            {active.length} active · {confirmed} confirmed
          </span>
          {!isActivity && confirmed > 0 && (
            <span
              className="lock-note"
              title="Confirmed evidence refers to these two entities. Retract or unconfirm it before moving an end."
            >
              Ends locked
            </span>
          )}
        </div>
        {(() => {
          const why = explainTruth(fact.truth_state, fact.assertions)
          return (
            <p className="truth-why">
              <CircleHelp size={13} />
              <span>
                {why.sentence}
                {why.notCounted ? ` ${why.notCounted}` : ''}
              </span>
            </p>
          )
        })()}
        <dl className="meta-list">
          {fact.valid_from ? (
            <>
              <dt>Valid from</dt>
              <dd>{date(fact.valid_from)}</dd>
            </>
          ) : factSpan(fact) ? (
            <>
              <dt>Observed</dt>
              <dd>{factSpan(fact)} UTC</dd>
            </>
          ) : (
            <>
              <dt>Valid from</dt>
              <dd>No date</dd>
            </>
          )}
          {fact.valid_to && (
            <>
              <dt>Valid to</dt>
              <dd>{date(fact.valid_to)}</dd>
            </>
          )}
        </dl>
        <Section
          title="Evidence"
          count={fact.assertions.length}
          action={
            <button className="text-button" onClick={() => onAdd('assertion')}>
              <Plus size={14} /> Add evidence
            </button>
          }
        >
          {fact.assertions.length ? (
            <EvidenceList
              fact={fact}
              data={data}
              onCopy={onCopy}
              onOpen={onOpenEvidence}
              onRetract={onRetract}
              hits={impact?.facts.get(fact.id)?.hits}
            />
          ) : (
            <p className="muted small">
              No evidence yet. A relationship stays <em>unknown</em> until confirmed evidence exists.
            </p>
          )}
        </Section>
        {linked.length > 0 && (
          <Section title="Linked by ID" count={linked.reduce((n, g) => n + g.total, 0)}>
            <LinkedActivities data={data} linked={linked} onSelect={onSelect} />
          </Section>
        )}
        <p className="inspector-note">
          <ShieldCheck size={14} /> Status is derived from confirmed, active evidence. Supporting and refuting evidence can coexist.
        </p>
      </div>
      <div className="inspector-foot">
        <button className="danger-link" onClick={() => onDelete('fact', fact.id)}>
          <Trash2 size={14} /> Delete {isActivity ? 'activity' : 'relationship'}
        </button>
      </div>
    </aside>
  )
}
export function ArrowDownIcon() {
  return (
    <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true">
      <path d="M6 0v15M1.5 11 6 16l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function IdentifierRow({
  identifier,
  data,
  onCopy,
  onDelete,
}: {
  identifier: Identifier
  data: GraphData
  onCopy: (value: string, label: string) => void
  onDelete: () => void
}) {
  const source = sourceOf(data, identifier.source_id)
  return (
    <div className="identifier-row">
      <span className="scheme-badge">{identifier.scheme}</span>
      <button className="identifier-value" onClick={() => onCopy(identifier.raw_value, 'Identifier')} title="Copy identifier">
        {identifier.raw_value}
      </button>
      <button title="Delete identifier" aria-label="Delete identifier" className="row-delete" onClick={onDelete}>
        <X size={13} />
      </button>
      <div className="identifier-meta">
        {identifier.namespace && <span>{identifier.namespace} · </span>}
        {source ? source.title : 'Manual'}
        {identifier.confidence < 1 ? ` · confidence ${Math.round(identifier.confidence * 100)}%` : ''}
        {(identifier.valid_from || identifier.valid_to) && (
          <>
            {' '}
            · {date(identifier.valid_from)} – {identifier.valid_to ? date(identifier.valid_to) : 'now'}
          </>
        )}
      </div>
    </div>
  )
}

/** The activity as a small picture: who and with what on the left, the operation, what it reached on the right. */
export function ActivityDiagram({
  data,
  fact,
  onSelect,
  impact,
}: {
  data: GraphData
  fact: Fact
  onSelect: (selection: Selection, focus?: boolean) => void
  impact: Impact | null
}) {
  const parts = fact.participants ?? []
  const left = parts.filter(p => p.role !== 'target'),
    right = parts.filter(p => p.role === 'target')
  const label = {
    compromised: 'compromised',
    derived: 'compromised (derived)',
    pivot: 'new with attacker',
    impacted: 'impacted',
    good: 'good',
  } as const
  const node = (p: { entity_id: string; role: string }) => {
    const mark = impact?.marks.get(p.entity_id)
    const kind = data.entities.find(e => e.id === p.entity_id)?.kind
    return (
      <button
        key={`${p.role}${p.entity_id}`}
        className={`diagram-node ${p.role}${mark ? ` mark-${mark}` : ''}`}
        onClick={() => onSelect({ kind: 'entity', id: p.entity_id }, true)}
        title={nameOf(data, p.entity_id)}
      >
        <small>
          {p.role}
          {kind ? ` · ${kind}` : ''}
          {mark ? <b> · {label[mark]}</b> : null}
        </small>
        <span>{nameOf(data, p.entity_id)}</span>
      </button>
    )
  }
  return (
    <div className="activity-diagram">
      <div className="diagram-side">{left.map(node)}</div>
      <div className={`diagram-op ${fact.truth_state}`}>
        <Zap size={13} />
        <span>{fact.predicate}</span>
      </div>
      <div className="diagram-side">{right.map(node)}</div>
    </div>
  )
}

/**
 * Evidence of an activity: what all rows share is said once (operation, who, on what); a table then shows per row only
 * what differs (time, IP, result, user agent, session …). Hand-written evidence without a row keeps its card.
 */
export function EvidenceList({
  fact,
  data,
  onCopy,
  onOpen,
  onRetract,
  hits,
}: {
  fact: Fact
  data: GraphData
  onCopy: (value: string, label: string) => void
  onOpen: (id: string) => void
  onRetract: (id: string) => void
  /** Evidence items inside the attacker window; the others happened before or after it. */
  hits?: Set<string>
}) {
  const [limit, setLimit] = useState(25)
  const items = [...fact.assertions].sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''))
  const rows = items.filter(a => rowFields(a).length),
    cards = items.filter(a => !rowFields(a).length)
  const values = new Map(rows.map(a => [a.id, new Map(rowFields(a))]))
  const labels = ROW_FIELDS.map(([label]) => label).filter(label => rows.some(a => values.get(a.id)!.has(label)))
  const common = labels.filter(label => rows.every(a => values.get(a.id)!.get(label) === values.get(rows[0].id)!.get(label)))
  const varying = labels.filter(label => !common.includes(label)).slice(0, 4)
  const sources = [...new Set(items.map(a => sourceOf(data, a.source_id)?.title.split(' · ')[0] ?? 'Manual entry'))]
  const counts = reviewCounts(items)
  const time = (a: Assertion) => (a.valid_from ? a.valid_from.slice(5, 19).replace('T', ' ') : '—')
  // Parsed by the import is a parser decision, not a person's check: say which is which.
  const parts = (
    [
      ['analyst', 'reviewed by analysts', 'ok-text'],
      ['import', 'parsed by the import', ''],
      ['agent', 'confirmed by agents only', 'warn-text'],
      ['open', 'to review', 'warn-text'],
    ] as const
  ).filter(([kind]) => counts[kind])
  return (
    <>
      <p className="evidence-summary">
        <b>{items.length.toLocaleString('en')}</b> {items.length === 1 ? 'item' : 'items'} from {sources.join(', ')} ·{' '}
        {parts.map(([kind, label, tone], i) => (
          <Fragment key={kind}>
            {i ? ', ' : ''}
            <b className={tone}>{counts[kind].toLocaleString('en')}</b> {label}
          </Fragment>
        ))}
        {hits ? (
          <>
            {' '}
            · <b className="danger-text">{hits.size}</b> in the attacker window
          </>
        ) : null}
      </p>
      {rows.length > 0 && (
        <>
          {common.length > 0 && (
            <dl className="row-fields common">
              {common.map(label => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <button
                      className="copy-value"
                      title={`Copy ${label}`}
                      onClick={() => onCopy(values.get(rows[0].id)!.get(label)!, label)}
                    >
                      {values.get(rows[0].id)!.get(label)}
                    </button>
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          <div className="evidence-grid-scroll">
            <table className="evidence-grid">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  {varying.map(label => (
                    <th key={label}>{label}</th>
                  ))}
                  <th aria-label="Review" />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map(a => (
                  <tr
                    key={a.id}
                    className={a.retracted_at ? 'retracted' : hits?.has(a.id) ? 'attack' : ''}
                    onClick={() => onOpen(a.id)}
                    title="Open the evidence and its original row"
                  >
                    <td className="mono">{time(a)}</td>
                    {varying.map(label => (
                      <td key={label} title={values.get(a.id)!.get(label)}>
                        {values.get(a.id)!.get(label) ?? '—'}
                      </td>
                    ))}
                    <td>{a.retracted_at ? <span className="muted">retracted</span> : <ReviewIcon item={a} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limit && (
            <button className="text-button" onClick={() => setLimit(limit + 100)}>
              Show {Math.min(100, rows.length - limit)} more of {rows.length - limit}
            </button>
          )}
        </>
      )}
      {cards.map(assertion => (
        <AssertionRow
          key={assertion.id}
          assertion={assertion}
          fact={fact}
          data={data}
          onCopy={onCopy}
          onOpen={() => onOpen(assertion.id)}
          onRetract={() => onRetract(assertion.id)}
        />
      ))}
    </>
  )
}

/** Analyst-checked, parsed by the import, confirmed by an agent only, or open; the title says who. */
export function ReviewIcon({ item }: { item: Assertion }) {
  const kind = reviewKind(item),
    title = `${reviewText(item)} · added: ${addedText(item)}`
  return kind === 'analyst' ? (
    <CheckCircle2 size={13} className="ok-text" aria-label={title}>
      <title>{title}</title>
    </CheckCircle2>
  ) : kind === 'import' ? (
    <FileCheck2 size={13} className="muted" aria-label={title}>
      <title>{title}</title>
    </FileCheck2>
  ) : kind === 'agent' ? (
    <Bot size={13} className="warn-text" aria-label={title}>
      <title>{title}</title>
    </Bot>
  ) : (
    <CircleDashed size={13} className="warn-text" aria-label={title}>
      <title>{title}</title>
    </CircleDashed>
  )
}

export function AssertionRow({
  assertion,
  fact,
  data,
  onCopy,
  onOpen,
  onRetract,
}: {
  assertion: Assertion
  fact: Fact
  data: GraphData
  onCopy: (value: string, label: string) => void
  onOpen: () => void
  onRetract: () => void
}) {
  const source = sourceOf(data, assertion.source_id)
  const period = evidencePeriod(assertion, fact)
  const fields = rowFields(assertion)
  const status = assertion.retracted_at ? 'retracted' : (assertion.review_status ?? 'unconfirmed')
  return (
    <div className={`assertion-card ${assertion.retracted_at ? 'retracted' : ''}`}>
      <div className="assertion-top">
        <span className={`stance ${assertion.stance}`}>{assertion.stance === 'supports' ? 'Supports' : 'Refutes'}</span>
        <span className={`review-badge ${status} ${reviewKind(assertion)}`} title={`Added: ${addedText(assertion)}`}>
          <ReviewIcon item={assertion} />
          {assertion.retracted_at ? 'retracted' : reviewText(assertion)}
        </span>
        {assertion.confidence < 1 && (
          <span className="assertion-conf" title="Confidence an analyst or agent assigned to this observation">
            confidence {Math.round(assertion.confidence * 100)}%
          </span>
        )}
      </div>
      {fields.length ? (
        <dl className="row-fields">
          {fields.map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>
                <button className="copy-value" title={`Copy ${label}`} onClick={() => onCopy(value, label)}>
                  {value}
                </button>
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="assertion-text">
          {assertion.observation || assertion.note || <span className="muted">No observation recorded.</span>}
        </p>
      )}
      {fields.length > 0 && (
        <details className="row-raw">
          <summary>Observation and original row</summary>
          <p className="assertion-text">{assertion.observation}</p>
          <pre>{JSON.stringify(rowOf(assertion), null, 2)}</pre>
        </details>
      )}
      <div className="assertion-source">
        <FileText size={13} />
        <span>{source ? source.title : 'Manual entry'}</span>
        {assertion.locator && (
          <code title="Where the row is in its source: the table and the columns that identify it (used for the KQL that finds it)">
            {assertion.locator}
          </code>
        )}
      </div>
      <div className="assertion-footer">
        <span>{periodLabel(period.from, period.to)}</span>
        <span className="assertion-actions">
          <button onClick={() => onCopy(assertion.id, 'Evidence ID')} title="Copy evidence ID" aria-label="Copy evidence ID">
            <Copy size={12} />
          </button>
          {!assertion.retracted_at && <button onClick={onRetract}>Retract</button>}
          <button className="strong" onClick={onOpen}>
            Open & review
          </button>
        </span>
      </div>
    </div>
  )
}
