const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { validateDrafts } = require(path + '/validation.js')
const { analyzeImpact, derivedCompromises, rotationProofs, effectOf, variableListingScript, impactMarkdown, sessionFindings, adviceFor, traceBack, agentFindings, attackSessions, startingPoints, caseSummary, firstUseOf, activityBefore, defaultSince, gapText, subnet } = require(path + '/impact.js')
const { huntingQueries, impactReport, evidenceQuery } = require(path + '/hunting.js')

let clock = 0
const ops = []
const act = (type, payload) => { ops.push({ id: `a${++clock}`, clock, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'b', type, payload }) }
const entity = (id, name, kind, ids = []) => { act('entity.add', { id, name, kind }); ids.forEach(([namespace, value, scheme = 'external_id'], i) => act('identifier.add', { id: `${id}-i${i}`, entity_id: id, scheme, namespace, raw_value: value, normalized_value: value })) }
const event = (id, predicate, participants, times) => {
  act('fact.add', { id, predicate, participants: participants.map(([entity_id, role]) => ({ entity_id, role })) })
  times.forEach((t, i) => act('assertion.add', { id: `${id}-e${i}`, fact_id: id, stance: 'supports', note: 'row', valid_from: t }))
}
entity('cred', 'clientSecret k1', 'Credential', [['entra-credential-key-id', 'k1']])
entity('sp', 'deploy-bot', 'Service Principal', [['entra-object-id', 'oid-1'], ['entra-app-id', 'app-1']])
entity('legit', '203.0.113.10', 'IP', [['', '203.0.113.10', 'ip']])
entity('evil', '198.51.100.66', 'IP', [['', '198.51.100.66', 'ip']])
entity('arm', 'Azure Resource Manager', 'Service')
entity('aks', 'aks-prod', 'AKS Cluster', [['', '/subscriptions/0/resourcegroups/rg/providers/microsoft.containerservice/managedclusters/aks-prod', 'resource_id']])
entity('st', 'stacc', 'Azure Resource', [['', '/subscriptions/0/resourcegroups/rg/providers/microsoft.storage/storageaccounts/stacc', 'resource_id']])
entity('ai', 'ai-acc', 'Azure Resource')
entity('user', 'ci-reader', 'User', [['gitlab-user-id', '4711']])
entity('repo', 'grp/sub/proj', 'Repository')
entity('env', '.env', 'File')
event('f1', 'signed in', [['sp', 'identity'], ['legit', 'source'], ['cred', 'tool'], ['arm', 'target']], ['2026-09-10T10:00:00.000Z'])
event('f2', 'signed in', [['sp', 'identity'], ['evil', 'source'], ['cred', 'tool'], ['arm', 'target']], ['2026-09-17T08:00:00.000Z'])
event('f3', 'listclusteradmincredential containerservice/managedclusters', [['sp', 'identity'], ['evil', 'source'], ['aks', 'target']], ['2026-09-17T08:10:00.000Z'])
event('f4', 'listkeys storage/storageaccounts', [['sp', 'identity'], ['evil', 'source'], ['st', 'target']], ['2026-09-01T08:20:00.000Z', '2026-09-17T08:20:00.000Z'])
event('f5', 'write cognitiveservices/accounts/deployments (failed)', [['sp', 'identity'], ['evil', 'source'], ['ai', 'target']], ['2026-09-17T08:30:00.000Z'])
event('f6', 'variable viewed api', [['user', 'actor'], ['evil', 'source'], ['repo', 'target']], ['2026-09-18T09:00:00.000Z', '2026-09-18T09:01:00.000Z'])
event('f7', 'repository file accessed api', [['user', 'actor'], ['evil', 'source'], ['repo', 'target'], ['env', 'target']], ['2026-09-18T09:05:00.000Z'])
event('f8', 'signed in', [['sp', 'identity'], ['legit', 'source'], ['arm', 'target']], ['2026-09-20T10:00:00.000Z'])
entity('cred2', 'clientSecret k2', 'Credential', [['entra-credential-key-id', 'k2']])
event('f9', 'sign-in failed (7000215)', [['cred2', 'tool'], ['evil', 'source'], ['arm', 'target']], ['2026-09-17T09:00:00.000Z'])
act('source.add', { id: 's1', title: 'AzureActivity (Sentinel) · export.csv', excerpt: '[{"Type": "AzureActivity"}]' })
act('source.add', { id: 's2', title: 'GitLab audit events (GitLab) · gitlab.csv', excerpt: '[{"Type": "GitLabAudit_CL", "author_id": 1}]' })

// What an operation does to its target.
assert.equal(effectOf('listkeys storage/storageaccounts'), 'secret')
assert.equal(effectOf('variable viewed api'), 'secret')
assert.equal(effectOf('delete resources/subscriptions/resourcegroups'), 'delete')
assert.equal(effectOf('write cognitiveservices/accounts/deployments'), 'write')
assert.equal(effectOf('write cognitiveservices/accounts/deployments (failed)'), 'attempt')
assert.equal(effectOf('sign-in failed (7000215)'), 'attempt')
assert.equal(effectOf('signed in'), 'auth')
assert.equal(effectOf('repository file accessed api', { kind: 'File', name: 'repo/.env' }), 'secret')
assert.equal(effectOf('repository file accessed api', { kind: 'File', name: 'README.md' }), 'read')
assert.equal(effectOf('git clone (ssh)'), 'read')

// Nothing marked: nothing to analyse.
assert.equal(analyzeImpact(project('b', ops).data).facts.size, 0)
// 1. The stolen secret from 15 September: its use from then on is the attacker's.
const mark = { type: 'entity.update', payload: { id: 'cred', compromise: { from: '2026-09-15T00:00:00.000Z', note: 'leaked in CI log' } } }
validateDrafts(project('b', ops).data, [mark])
assert.throws(() => validateDrafts(project('b', ops).data, [{ type: 'entity.update', payload: { id: 'cred', compromise: { from: '2026-09-15', to: '2026-09-01' } } }]), /after its start/)
act(mark.type, mark.payload)
let data = project('b', ops).data
assert.deepEqual(data.entities.find(e => e.id === 'cred').compromise, { from: '2026-09-15T00:00:00.000Z', to: null, note: 'leaked in CI log', by: 'Analyst', at: '2026-10-04T00:00:00.000Z', via: 'UI' })
let impact = analyzeImpact(data)
assert.deepEqual([...impact.facts.keys()], ['f2'], 'f1 is before the secret was stolen')
// Pivots: the IP is new since the compromise; the service principal used the secret before it was stolen.
let pivot = id => impact.pivots.find(p => p.entity.id === id)
assert.equal(pivot('evil').before, 0); assert.equal(pivot('sp').before, 1)
assert.equal(impact.pivots[0].entity.id, 'evil', 'new since the compromise first')
assert.ok(!pivot('legit'), 'the legitimate IP did not use the stolen secret')
assert.equal(impact.marks.get('evil'), 'pivot'); assert.equal(impact.marks.get('sp'), undefined)

// 2. Pivot: the IP is the attacker's. Whatever it used successfully is compromised no later than its first use.
act('entity.update', { id: 'evil', compromise: {} })
data = project('b', ops).data
assert.deepEqual(Object.fromEntries([...derivedCompromises(data)].map(([id, d]) => [id, [d.at, d.via, d.fact]])),
  { sp: ['2026-09-01T08:20:00.000Z', 'evil', 'f4'], user: ['2026-09-18T09:00:00.000Z', 'evil', 'f6'] },
  'the service principal and the GitLab account; not the explicitly marked secret, not targets, not the key of a failed sign-in, not the legitimate IP')
impact = analyzeImpact(data)
assert.equal(impact.seeds.find(s => s.entity.id === 'sp').derived.at, '2026-09-01T08:20:00.000Z')
assert.equal(impact.marks.get('sp'), 'derived'); assert.equal(impact.marks.get('cred'), 'compromised')
assert.ok(impact.facts.has('f8'), 'a compromised service principal: its later sign-in from the usual IP counts too')
// The analyst checks the service principal: not compromised (the IP only used its stolen secret). Never derived again.
act('entity.update', { id: 'sp', compromise: { cleared: true, note: 'only the secret' } })
data = project('b', ops).data
assert.equal(data.entities.find(e => e.id === 'sp').compromise.cleared, true)
impact = analyzeImpact(data)
assert.ok(!impact.seeds.some(s => s.entity.id === 'sp') && !impact.pivots.some(p => p.entity.id === 'sp'), 'cleared: neither compromised nor a pivot')
assert.deepEqual([...impact.facts.keys()].sort(), ['f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f9'])
assert.equal(impact.facts.get('f4').count, 2, 'the IP is compromised without a window: both listKeys calls count')
assert.equal(impact.first, '2026-09-01T08:20:00.000Z')
const effect = id => impact.impacted.find(i => i.entity.id === id)?.effect
assert.deepEqual(['aks', 'st', 'repo', 'env', 'arm', 'ai'].map(effect), ['secret', 'secret', 'secret', 'secret', 'auth', 'attempt'])
assert.equal(impact.impacted[0].effect, 'secret', 'worst first')
assert.deepEqual(impact.steps.map(s => s.operation).slice(0, 3), ['listkeys storage/storageaccounts', 'signed in', 'listclusteradmincredential containerservice/managedclusters'])
assert.deepEqual(impact.steps.find(s => s.operation === 'variable viewed api').seeds.sort(), ['evil', 'user'])
// What to rotate: the stolen secret first, then the attacker's IP, then what was exposed; nothing for the failed attempt.
const titles = impact.rotation.map(r => r.title)
assert.equal(impact.rotation[0].category, 'revoke'); assert.match(titles[0], /client secret/)
for (const pattern of [/^Block 198\.51\.100\.66/, /^Reset ci-reader/, /cluster certificates of aks-prod/, /storage keys of stacc/, /CI\/CD variables of grp\/sub\/proj/, /secrets in \.env/])
  assert.ok(titles.some(t => pattern.test(t)), pattern)
assert.ok(!titles.some(t => /ai-acc|k2/.test(t)), 'a failed attempt needs no rotation, and its key is not compromised')
assert.equal(impact.rotation.find(r => /client secret/.test(r.title)).lastUse, '2026-09-17T08:00:00.000Z', "the secret's last successful use by the attacker")
// GitLab: the projects whose variables were read, with the groups they inherit from, and a script to list the keys.
assert.deepEqual(impact.variables.map(v => [v.path, v.groups, v.count]), [['grp/sub/proj', ['grp', 'grp/sub'], 2]])
const script = variableListingScript(impact.variables)
assert.match(script, /for p in 'grp\/sub\/proj'; do/); assert.match(script, /for g in 'grp' 'grp\/sub'; do/)

// 3. Rotation by hand: before the attacker's last use it has to be repeated.
act('entity.update', { id: 'st', rotated_at: '2026-09-17T08:00:00.000Z' })
impact = analyzeImpact(project('b', ops).data)
assert.equal(impact.rotation.find(r => /storage keys/.test(r.title)).stale, true)
act('entity.update', { id: 'st', rotated_at: null })
// 4. Rotation proven by an import: the key removed in AuditLogs, storage keys regenerated in AzureActivity.
entity('admin', 'admin@contoso.example', 'User')
event('r1', 'credential removed', [['admin', 'actor'], ['cred', 'target']], ['2026-09-25T10:00:00.000Z'])
event('r2', 'regeneratekey storage/storageaccounts', [['admin', 'actor'], ['st', 'target']], ['2026-09-16T10:00:00.000Z'])
event('r3', 'credential removed (failed)', [['admin', 'actor'], ['cred2', 'target']], ['2026-09-25T10:00:00.000Z'])
impact = analyzeImpact(project('b', ops).data)
const item = pattern => impact.rotation.find(r => pattern.test(r.title))
assert.deepEqual([item(/client secret/).proof, item(/client secret/).rotatedAt, item(/client secret/).stale], [{ at: '2026-09-25T10:00:00.000Z', fact: 'r1', operation: 'credential removed' }, '2026-09-25T10:00:00.000Z', false])
assert.equal(item(/storage keys/).stale, true, 'regenerated before the attacker listed the keys again: not enough')
event('r4', 'regeneratekey storage/storageaccounts', [['admin', 'actor'], ['st', 'target']], ['2026-09-26T10:00:00.000Z'])
impact = analyzeImpact(project('b', ops).data)
assert.deepEqual([item(/storage keys/).proof.at, item(/storage keys/).stale], ['2026-09-26T10:00:00.000Z', false], 'the latest proof counts (the same activity again: more evidence on it)')
assert.ok(!rotationProofs(project('b', ops).data).has('cred2'), 'a failed removal proves nothing')
// A compromised service principal is rotated once every compromised credential seen with it is removed.
act('entity.update', { id: 'sp', compromise: { from: '2026-09-15T00:00:00.000Z' } })
impact = analyzeImpact(project('b', ops).data)
assert.deepEqual([item(/all credentials of deploy-bot/).proof?.fact, item(/all credentials of deploy-bot/).stale], ['r1', false])
act('entity.update', { id: 'sp', compromise: { cleared: true } })
// An attacker-added credential is a backdoor to remove.
entity('backdoor', 'clientSecret k9', 'Credential', [['entra-credential-key-id', 'k9']])
event('b1', 'credential added', [['user', 'actor'], ['evil', 'source'], ['backdoor', 'target']], ['2026-09-18T10:00:00.000Z'])
impact = analyzeImpact(project('b', ops).data)
assert.equal(item(/^Remove clientSecret k9/).category, 'revoke')

// Hunting: filled with the key ID, the IPs, the clusters and the storage account; GitLab uses the exported table.
data = project('b', ops).data
let queries = huntingQueries(data, impact)
const q = id => queries.find(x => x.id === id)
assert.match(q('credential-use').query, /ServicePrincipalCredentialKeyId in \(dynamic\(\["k1"\]\)\)/)
assert.equal(q('credential-use').importable, 'AADServicePrincipalSignInLogs')
assert.match(q('credential-use').query, /^let start = datetime\(2026-09-04T09:00:00.000Z\);/, 'two weeks before the first known use of the derived GitLab account')
assert.match(q('rotation-proof').query, /let keys = dynamic\(\["k1"\]\);/); assert.equal(q('rotation-proof').importable, 'Entra credential changes')
for (const column of ['CredentialChange', 'KeyId', 'ApplicationObjectId', 'KeyType', 'Actor', 'ActorIp']) assert.ok(q('rotation-proof').query.includes(column), column)
assert.match(q('rotation-proof').query, /KeyIdentifier=", KeyId, @",\\s\*KeyType=\(\\w\+\)"/)
assert.match(q('ip-everywhere').query, /"198\.51\.100\.66"/); assert.match(q('ip-everywhere').query, /GitLabAudit_CL \| where/)
assert.ok(!q('ip-everywhere').query.includes('203.0.113.10'), 'the legitimate IP is not hunted')
assert.match(q('aks-admin').query, /managedclusters\/aks-prod/)
assert.match(q('storage-keys').query, /"stacc"/)
assert.match(q('gitlab-projects').query, /GitLabAudit_CL\n/)
assert.equal(q('resource-others').imported, true, 'AzureActivity is already on the board')
assert.ok(!q('sp-signins'), 'the service principal is cleared: no service principal queries')
act('entity.update', { id: 'sp', compromise: { from: '2026-09-15T00:00:00.000Z' } })
data = project('b', ops).data; impact = analyzeImpact(data); queries = huntingQueries(data, impact)
for (const id of ['sp-signins', 'sp-azure', 'sp-keyvault', 'sp-graph', 'sp-persistence']) assert.ok(q(id), id)
assert.match(q('sp-azure').query, /Caller in~ \(dynamic\(\["oid-1"\]\)\)/)
assert.match(q('rotation-proof').query, /let names = dynamic\(\["deploy-bot"\]\);/)
// Clearing a compromise removes it from the analysis.
act('entity.update', { id: 'sp', compromise: null })
assert.ok(analyzeImpact(project('b', ops).data).seeds.find(s => s.entity.id === 'sp').derived, 'unmarked again: derived from the attacker IP once more')
// Report for REST / MCP and Markdown for a ticket.
const report = impactReport(project('b', ops).data)
assert.ok(report.seeds.some(s => s.derived?.via === '198.51.100.66')); assert.ok(report.hunting.length > 4)
assert.deepEqual(report.variables_read, { projects: ['grp/sub/proj'], inherited_from_groups: ['grp', 'grp/sub'], total: 1 })
assert.equal(report.rotation_guidance[report.rotate[0].guidance].length > 20, true)
assert.ok(JSON.stringify(report).length < 60_000)
const markdown = impactMarkdown(analyzeImpact(project('b', ops).data), id => project('b', ops).data.entities.find(e => e.id === id)?.name ?? id, queries.slice(0, 1))
assert.match(markdown, /## Rotate, revoke, block/); assert.match(markdown, /```kusto/); assert.match(markdown, /\(derived\): used from 198\.51\.100\.66/)
// Sessions (Entra UniqueTokenIdentifier / uti claim), "likely regular" activity, trace back, advice, KQL per evidence item.
{
  const more = []
  let n = 0
  const add = (type, payload) => more.push({ id: `s${++n}`, clock: n, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'c', type, payload })
  const ent = (id, kind, name = id) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, parts, items) => { add('fact.add', { id, predicate, participants: parts.map(([entity_id, role]) => ({ entity_id, role })) })
    items.forEach(([t, note, locator, observation], i) => add('assertion.add', { id: `${id}-${i}`, fact_id: id, stance: 'supports', valid_from: t, note: note ?? 'row', locator, observation, source_id: null })) }
  ent('alice', 'User', 'alice@contoso.example'); ent('attacker', 'IP', '198.51.100.7'); ent('home', 'IP', '203.0.113.30'); ent('proxy', 'IP', '198.51.100.9')
  ent('e1', 'IP', '192.0.2.1'); ent('e2', 'IP', '192.0.2.2'); ent('portal', 'Service'); ent('vault', 'Key Vault'); ent('st2', 'Azure Resource'); ent('ci', 'Credential', 'clientSecret c-1')
  ent('runner', 'IP', '203.0.113.40'); ent('repo', 'Repository', 'team/app'); ent('sp2', 'Service Principal', 'deploy-2')
  // Theft: alice's token first from her home IP, then from the attacker.
  ev('t1', 'signed in', [['alice', 'identity'], ['home', 'source'], ['portal', 'target']], [['2026-09-20T10:00:00.000Z', '{"UniqueTokenIdentifier": "tokenAAAA1111bbbb"}']])
  ev('t2', 'write keyvault/vaults', [['alice', 'identity'], ['attacker', 'source'], ['vault', 'target']], [['2026-09-20T11:00:00.000Z', '{"Claims": {"uti": "tokenAAAA1111bbbb"}}', 'AzureActivity CorrelationId=c-9 EventDataId=e-9']])
  // Redirector: another token from the attacker first, then from a second IP.
  ev('t3', 'signed in', [['alice', 'identity'], ['attacker', 'source'], ['portal', 'target']], [['2026-09-21T08:00:00.000Z', '{"UniqueTokenIdentifier": "tokenCCCC2222dddd"}']])
  ev('t4', 'signed in', [['alice', 'identity'], ['proxy', 'source'], ['portal', 'target']], [['2026-09-21T09:00:00.000Z', '{"UniqueTokenIdentifier": "tokenCCCC2222dddd"}']])
  // Replay without a known attacker.
  ev('t5', 'signed in', [['alice', 'identity'], ['e1', 'source'], ['portal', 'target']], [['2026-09-22T08:00:00.000Z', '{"UniqueTokenIdentifier": "tokenEEEE3333ffff"}']])
  ev('t6', 'signed in', [['alice', 'identity'], ['e2', 'source'], ['portal', 'target']], [['2026-09-22T08:05:00.000Z', '{"UniqueTokenIdentifier": "tokenEEEE3333ffff"}']])
  // Likely regular: the stolen secret listed the keys from the usual runner before the compromise too.
  ev('r1', 'listkeys storage/storageaccounts', [['ci', 'tool'], ['runner', 'source'], ['st2', 'target']], [['2026-09-10T06:00:00.000Z', null, null, 'listkeys · ASN 64500'], ['2026-09-16T06:00:00.000Z']])
  // New IPs after the compromise: one from the provider the secret always came from, one from elsewhere.
  ent('cloud', 'IP', '203.0.113.41'); ent('odd', 'IP', '192.0.2.99')
  ev('n1', 'signed in', [['ci', 'tool'], ['cloud', 'source'], ['portal', 'target']], [['2026-09-17T06:00:00.000Z', null, null, 'signed in · ASN 64500']])
  ev('n2', 'signed in', [['ci', 'tool'], ['odd', 'source'], ['portal', 'target']], [['2026-09-17T07:00:00.000Z', null, null, 'signed in · ASN 65001']])
  // Trace back: the attacker reads CI/CD variables, then a service principal shows up from the attacker IP.
  ev('v1', 'variable viewed api', [['attacker', 'source'], ['repo', 'target']], [['2026-09-19T07:00:00.000Z']])
  ev('d1', 'signed in', [['sp2', 'identity'], ['attacker', 'source'], ['portal', 'target']], [['2026-09-19T09:00:00.000Z']])
  add('entity.update', { id: 'attacker', compromise: {} })
  add('entity.update', { id: 'ci', compromise: { from: '2026-09-15T00:00:00.000Z' } })
  const data = project('c', more).data
  const impact = analyzeImpact(data)
  const findings = sessionFindings(data, impact)
  const kind = uti => findings.find(f => f.uti === uti)
  assert.deepEqual([kind('tokenCCCC2222dddd').kind, kind('tokenCCCC2222dddd').others], ['redirector', ['proxy']])
  assert.deepEqual([kind('tokenAAAA1111bbbb').kind, kind('tokenAAAA1111bbbb').others], ['theft', ['home']])
  assert.equal(kind('tokenEEEE3333ffff').kind, 'replay')
  assert.equal(findings[0].kind, 'redirector', 'redirectors first')
  const regular = impact.impacted.find(i => i.entity.id === 'st2')
  assert.deepEqual([regular.regular, impact.facts.get('r1').before], [true, 1])
  assert.ok(!impact.rotation.some(r => r.entityId === 'st2'), 'likely regular: nothing to rotate')
  const trace = traceBack(impact).find(t => t.entity.id === 'sp2')
  assert.deepEqual([trace.derived, trace.at, trace.exposedBy[0].operation], [true, '2026-09-19T09:00:00.000Z', 'variable viewed api'])
  const advice = adviceFor(data, impact)
  const a = id => advice.find(x => x.id === id)
  assert.deepEqual(a('uti-tokenCCCC2222dddd').mark, ['proxy']); assert.equal(a('uti-tokenCCCC2222dddd').severity, 'high')
  assert.match(a('uti-tokenAAAA1111bbbb').title, /stolen from 203\.0\.113\.30/)
  // Only timing points there: a hypothesis with the real time between, never "right after" or proven.
  assert.equal(a('trace-sp2').title, 'Possible origin of deploy-2: variable viewed api (2 hours earlier)')
  assert.equal(a('trace-sp2').severity, 'medium')
  assert.match(a('trace-sp2').detail, /^Hypothesis from timing only\./)
  assert.doesNotMatch(a('trace-sp2').detail, /right after/)
  assert.deepEqual([gapText('2026-09-17T08:00:00.000Z', '2026-09-27T09:00:00.000Z'), gapText('2026-09-17T08:00:00.000Z', '2026-09-17T08:12:00.000Z')], ['10 days', '12 minutes'])
  assert.ok(a('confirm-derived').confirm.includes('sp2'))
  assert.ok(!advice.some(x => x.id === 'pivot-runner'), 'the usual runner is no attacker candidate')
  assert.deepEqual([a('pivot-cloud').severity, a('pivot-cloud').title], ['info', '203.0.113.41: new IP, but the usual provider (AS64500)'])
  assert.equal(a('pivot-odd').severity, 'medium', 'a new provider, but little history to compare with')
  assert.match(a('pivot-odd').detail, /AS65001 was not seen with it before/); assert.match(a('pivot-odd').detail, /Only 1 event before the compromise/)
  assert.equal(advice[0].severity, 'high')
  // Sessions: who used the attacker's session after them holds it (redirector); who used it before is the victim.
  const derivedNow = derivedCompromises(data)
  assert.deepEqual([derivedNow.get('proxy')?.reason, derivedNow.has('home')], ['session', false])
  assert.ok(attackSessions(data, impact).some(x => x.uti === 'tokenCCCC2222dddd' && x.ips.length === 2))
  // Missing baseline: deploy-2 shows up only with the attacker; the secret and alice have history before.
  assert.deepEqual(['sp2', 'ci', 'alice'].map(id => a('baseline').entities.includes(id)), [true, false, false])
  // The session query names the tokens; KQL for one evidence item finds the original row.
  const queries = huntingQueries(data, impact)
  assert.match(queries.find(q => q.id === 'session-replay').query, /"tokenCCCC2222dddd"/)
  assert.equal(evidenceQuery({ locator: 'AzureActivity CorrelationId=c-9 EventDataId=e-9', valid_from: '2026-09-20T11:00:00.000Z', source_id: null }, []),
    'AzureActivity\n| where TimeGenerated between (datetime(2026-09-20T11:00:00.000Z) - 10m .. datetime(2026-09-20T11:00:00.000Z) + 10m)\n| where CorrelationId == "c-9" and EventDataId == "e-9"')
  assert.match(evidenceQuery({ locator: 'GitLab audit events id=42', valid_from: '2026-09-20T11:00:00.000Z', source_id: 'g' }, [{ id: 'g', title: 'GitLab audit events (GitLab) · x.csv', excerpt: '[{"Type": "GitLabAudit_CL"}]' }]), /^GitLabAudit_CL\n.*\n\| where id == "42"$/)
  assert.match(evidenceQuery({ locator: 'Entra credential changes CorrelationId=c1 KeyId=k', valid_from: '2026-09-25T10:00:00.000Z', source_id: null }, []), /^AuditLogs\n.*\n\| where CorrelationId == "c1"$/)
}
// User agents and "good": the attacker's tooling elsewhere is a lead; activity from good infrastructure is the owner.
{
  const more = []
  let n = 0
  const add = (type, payload) => more.push({ id: `u${++n}`, clock: n, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'u', type, payload })
  const ent = (id, kind, name = id) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, parts, t, agent) => { add('fact.add', { id, predicate, participants: parts.map(([entity_id, role]) => ({ entity_id, role })) })
    add('assertion.add', { id: `${id}-e`, fact_id: id, stance: 'supports', valid_from: t, note: JSON.stringify({ UserAgent: agent }) }) }
  ent('key', 'Credential', 'clientSecret u-1'); ent('bad', 'IP', '198.51.100.20'); ent('mate', 'IP', '198.51.100.21'); ent('runner', 'IP', '203.0.113.50'); ent('arm', 'Service')
  ev('b0', 'signed in', [['key', 'tool'], ['runner', 'source'], ['arm', 'target']], '2026-09-01T00:00:00.000Z', 'azure-cli/2.60')
  ev('b1', 'signed in', [['key', 'tool'], ['bad', 'source'], ['arm', 'target']], '2026-09-20T00:00:00.000Z', 'python-requests/9.9.9')
  ev('b2', 'signed in', [['key', 'tool'], ['mate', 'source'], ['arm', 'target']], '2026-09-20T01:00:00.000Z', 'python-requests/9.9.9')
  ev('b3', 'signed in', [['key', 'tool'], ['runner', 'source'], ['arm', 'target']], '2026-09-21T00:00:00.000Z', 'azure-cli/2.60')
  add('entity.update', { id: 'key', compromise: { from: '2026-09-15T00:00:00.000Z' } })
  add('entity.update', { id: 'bad', compromise: {} })
  let data = project('u', more).data, impact = analyzeImpact(data)
  const finding = agentFindings(data, impact).find(f => f.agent === 'python-requests/9.9.9')
  assert.deepEqual([finding.baseline, finding.attackerIps, finding.others], [false, ['bad'], ['mate']])
  assert.ok(agentFindings(data, impact).find(f => f.agent === 'azure-cli/2.60').baseline, 'the usual tooling of the secret before it was stolen')
  const advice = adviceFor(data, impact)
  assert.deepEqual(advice.find(x => x.id === 'ua-python-requests/9.9.9').mark, ['mate'])
  assert.match(huntingQueries(data, impact).find(q => q.id === 'agent-hunt').query, /"python-requests\/9\.9\.9"/)
  assert.match(huntingQueries(data, impact).find(q => q.id === 'credential-usage').query, /bin\(TimeGenerated, 1h\)/)
  assert.equal(impact.facts.get('b0').before, 1, 'the runner after the theft is the same activity as before it (b3 merged into b0): likely regular')
  add('entity.update', { id: 'runner', compromise: { cleared: true, note: 'our CI runner' } })
  data = project('u', more).data; impact = analyzeImpact(data)
  assert.ok(!impact.facts.has('b0'), 'activity from good infrastructure is not the attacker')
  assert.equal(impact.marks.get('runner'), 'good')
}
// Where to start, suspected vs confirmed, and the case summary with its open questions.
{
  const more = []
  let n = 0
  const add = (type, payload) => more.push({ id: `w${++n}`, clock: n, at: '2026-10-05T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'w', type, payload })
  const ent = (id, kind, name = id) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, parts, times, note = 'row') => { add('fact.add', { id, predicate, participants: parts.map(([entity_id, role]) => ({ entity_id, role })) })
    times.forEach((t, i) => add('assertion.add', { id: `${id}-${i}`, fact_id: id, stance: 'supports', valid_from: t, note })) }
  ent('jdoe', 'User', 'j.doe@corp.example'); ent('ws', 'Device', 'ws-0142'); ent('outlook', 'Process', 'outlook.exe'); ent('ps', 'Process', 'powershell.exe')
  ent('spray', 'IP', '192.0.2.77'); ent('portal', 'Service'); ent('bot', 'Service Principal', 'deploy-9'); ent('kv', 'Key Vault', 'kv-prod')
  ent('s1', 'Azure Resource'); ent('s2', 'Azure Resource'); ent('s3', 'Azure Resource')
  ev('p1', 'process created', [['jdoe', 'actor'], ['outlook', 'via'], ['ps', 'target'], ['ws', 'other']], ['2026-09-20T08:00:00.000Z'], JSON.stringify({ ProcessCommandLine: 'powershell -enc JABXAGMAPQBOAGUAdwA=' }))
  ev('f1', 'sign-in failed (50126)', [['jdoe', 'identity'], ['spray', 'source'], ['portal', 'target']], ['2026-09-20T07:00:00.000Z', '2026-09-20T07:01:00.000Z', '2026-09-20T07:02:00.000Z', '2026-09-20T07:03:00.000Z', '2026-09-20T07:04:00.000Z'])
  ev('f2', 'signed in', [['jdoe', 'identity'], ['spray', 'source'], ['portal', 'target']], ['2026-09-20T07:05:00.000Z'])
  for (const r of ['s1', 's2', 's3']) ev(`k${r}`, 'listkeys storage/storageaccounts', [['bot', 'identity'], ['spray', 'source'], [r, 'target']], ['2026-09-20T09:00:00.000Z'])
  ev('v1', 'secretget keyvault/vaults', [['bot', 'identity'], ['spray', 'source'], ['kv', 'target']], ['2026-09-20T09:05:00.000Z'])
  let data = project('w', more).data
  const points = startingPoints(data)
  const point = prefix => points.find(x => x.id.startsWith(prefix))
  assert.match(point('cmd-').title, /powershell -enc JABX/); assert.ok(point('cmd-').mark.includes('ws') && point('cmd-').mark.includes('jdoe'))
  assert.equal(point('office-').title, 'outlook.exe started powershell.exe')
  assert.deepEqual([point('spray-').title, point('spray-').mark], ['5 failed, then 1 successful sign-ins from 192.0.2.77', ['spray']])
  assert.match(point('secrets-').title, /deploy-9 read keys or secrets of 4 resources/)
  // Marked as suspected: the same analysis, labelled suspected, also what is derived from it.
  add('entity.update', { id: 'spray', compromise: { level: 'suspected' } })
  data = project('w', more).data
  assert.equal(data.entities.find(e => e.id === 'spray').compromise.level, 'suspected')
  const impact = analyzeImpact(data)
  assert.deepEqual(['spray', 'bot', 'jdoe'].map(id => impact.seeds.find(x => x.entity.id === id)?.suspected), [true, true, true])
  assert.ok(impact.facts.has('ks1'))
  const summary = caseSummary(data, impact)
  assert.ok(summary.suspected.some(line => /Suspected compromised: 192\.0\.2\.77/.test(line)))
  // Only suspected: nothing of it is "known", all of it is suspected.
  assert.deepEqual(summary.known, [])
  assert.ok(summary.suspected.some(line => /Secrets possibly exposed on 4 more resources, by suspected or derived entities/.test(line)))
  assert.ok(summary.suspected.some(line => /by suspected or derived entities only/.test(line)))
  const gap = q => summary.gaps.find(g => g.query === q)
  assert.match(gap('sp-keyvault').question, /Which secrets were read from kv-prod/)
  assert.match(gap('storage-keys').question, /What did the storage keys enable/)
  assert.ok(gap('ip-everywhere'))
  assert.equal(startingPoints(data).filter(x => x.mark.includes('spray')).length, 0, 'marked entities are no starting point any more')
  // Confirmed, and the derived service principal confirmed too: now it is known.
  add('entity.update', { id: 'spray', compromise: { level: 'confirmed' } })
  add('entity.update', { id: 'bot', compromise: { level: 'confirmed', from: '2026-09-01T00:00:00Z' } })
  data = project('w', more).data
  const known = caseSummary(data, analyzeImpact(data)).known
  assert.ok(known.some(line => /Secrets possibly exposed on 4 resources \(a secret-read operation succeeded\)/.test(line)), known.join('\n'))
  assert.ok(known.some(line => /Attacker activity by confirmed compromised entities/.test(line)))
}
{
  // The window decides per evidence item: the same activity before the window is not the attacker's.
  const more = []
  let n = 0
  const add = (type, payload) => more.push({ id: `w${++n}`, clock: n, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'w', type, payload })
  const ent = (id, name, kind) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, participants, times) => {
    add('fact.add', { id, predicate, participants: participants.map(([entity_id, role]) => ({ entity_id, role })) })
    times.forEach((t, i) => add('assertion.add', { id: `${id}-e${i}`, fact_id: id, stance: 'supports', note: 'row', valid_from: t }))
  }
  ent('vpn', '192.0.2.200', 'IP'); ent('key', 'clientSecret k9', 'Credential'); ent('app', 'billing-app', 'Service Principal'); ent('web', 'portal', 'Service'); ent('kv', 'kv-prod', 'Key Vault')
  // The IP served someone else before the attacker had the secret (a shared exit): browsing the portal in August.
  ev('early', 'page viewed', [['vpn', 'source'], ['web', 'target']], ['2026-08-02T10:00:00.000Z', '2026-08-03T11:00:00.000Z'])
  // First use of the application from it on 1 September; the stolen secret on 17 September.
  ev('use', 'signed in', [['app', 'identity'], ['key', 'tool'], ['vpn', 'source'], ['web', 'target']], ['2026-09-17T08:00:00.000Z'])
  ev('read', 'secretget keyvault', [['app', 'identity'], ['vpn', 'source'], ['kv', 'target']], ['2026-09-01T09:00:00.000Z', '2026-09-18T09:00:00.000Z'])
  let data = project('w', more).data
  const vpn = data.entities.find(e => e.id === 'vpn')
  assert.equal(firstUseOf(data, 'vpn'), '2026-09-01T09:00:00.000Z')
  assert.equal(activityBefore(data, 'vpn', '2026-09-01T09:00:00.000Z'), 2)
  assert.equal(defaultSince(data, vpn), '2026-09-01T09:00:00.000Z')
  assert.equal(defaultSince(data, data.entities.find(e => e.id === 'key')), null, 'a credential start is the analyst\'s call')
  // Marked without a start: everything counts, also August.
  add('entity.update', { id: 'vpn', compromise: { level: 'confirmed' } })
  let impact = analyzeImpact(project('w', more).data)
  assert.ok(impact.facts.has('early'))
  // Marked from the secret's first use: August is not the attacker's, and only the later read of the vault is.
  add('entity.update', { id: 'vpn', compromise: { from: '2026-09-17T08:00:00.000Z', level: 'confirmed' } })
  impact = analyzeImpact(project('w', more).data)
  assert.equal(impact.facts.has('early'), false)
  assert.deepEqual([...impact.facts.get('read').hits], ['read-e1'])
  assert.equal(impact.facts.get('read').count, 1)
  assert.equal(impact.facts.get('read').before, 1)
}
{
  // The attacker's own key operation is no proof of rotation: regenerateKey hands them the new keys.
  const log = []
  let n = 0
  const add = (type, payload) => log.push({ id: `k${++n}`, clock: n, at: '2026-10-06T00:00:00Z', actor: 'me', author: 'Analyst', boardId: 'k', type, payload })
  const ent = (id, name, kind) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, participants, times) => {
    add('fact.add', { id, predicate, participants: participants.map(([entity_id, role]) => ({ entity_id, role })) })
    times.forEach((t, i) => add('assertion.add', { id: `${id}-e${i}`, fact_id: id, stance: 'supports', note: 'row', valid_from: t }))
  }
  ent('sp', 'deploy-bot', 'Service Principal'); ent('admin', 'jo.admin', 'User'); ent('st', 'stprod', 'Azure Resource')
  ev('keys', 'listkeys storage/storageaccounts', [['sp', 'identity'], ['st', 'target']], ['2026-09-20T10:00:00Z'])
  ev('regen', 'regeneratekey storage/storageaccounts', [['sp', 'identity'], ['st', 'target']], ['2026-09-20T10:05:00Z'])
  add('entity.update', { id: 'sp', compromise: { from: '2026-09-19T00:00:00Z', level: 'confirmed' } })
  let data = project('k', log).data
  let impact = analyzeImpact(data)
  const storage = () => impact.rotation.find(r => r.entityId === 'st' && r.key === 'storage-keys')
  assert.equal(storage().proof, null, 'the attacker regenerated the keys: not proven')
  assert.equal(storage().rotatedAt, null)
  assert.ok(adviceFor(data, impact).some(a => a.id === 'attacker-rotation-regen' && a.severity === 'high'))
  // The administrator regenerates them afterwards: that is the proof.
  ev('regen-admin', 'regeneratekey storage/storageaccounts', [['admin', 'actor'], ['st', 'target']], ['2026-09-21T09:00:00Z'])
  data = project('k', log).data
  impact = analyzeImpact(data)
  assert.equal(storage().proof?.fact, 'regen-admin')
  assert.equal(storage().stale, false)
}
// Networks: /24 for IPv4, /64 for IPv6 (also written short or with brackets).
assert.deepEqual([subnet('203.0.113.7'), subnet('2001:db8:1:2::abcd'), subnet('[2001:0db8:0001:0002:0:0:0:1]'), subnet('fe80::1%eth0'), subnet('not-an-ip'), subnet('1::2::3')],
  ['203.0.113.0/24', '2001:db8:1:2::/64', '2001:db8:1:2::/64', 'fe80:0:0:0::/64', null, null])
console.log('Impact: compromise windows, derived compromise, attacker activities, effects, pivots, attack path, rotation with proof, CI/CD variables, hunting queries and report passed')
