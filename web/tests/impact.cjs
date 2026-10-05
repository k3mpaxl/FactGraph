const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { validateDrafts } = require(path + '/validation.js')
const { analyzeImpact, derivedCompromises, rotationProofs, effectOf, variableListingScript, impactMarkdown, sessionFindings, adviceFor, traceBack } = require(path + '/impact.js')
const { huntingQueries, impactReport, evidenceQuery } = require(path + '/hunting.js')

let clock = 0
const ops = []
const act = (type, payload) => { ops.push({ id: `a${++clock}`, clock, at: '2026-10-04T00:00:00Z', actor: 'me', author: 'Analyst', boardId: 'b', type, payload }) }
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
event('f1', 'signed in', [['sp', 'identity'], ['legit', 'source'], ['cred', 'tool'], ['arm', 'target']], ['2026-09-10T10:00:00Z'])
event('f2', 'signed in', [['sp', 'identity'], ['evil', 'source'], ['cred', 'tool'], ['arm', 'target']], ['2026-09-17T08:00:00Z'])
event('f3', 'listclusteradmincredential containerservice/managedclusters', [['sp', 'identity'], ['evil', 'source'], ['aks', 'target']], ['2026-09-17T08:10:00Z'])
event('f4', 'listkeys storage/storageaccounts', [['sp', 'identity'], ['evil', 'source'], ['st', 'target']], ['2026-09-01T08:20:00Z', '2026-09-17T08:20:00Z'])
event('f5', 'write cognitiveservices/accounts/deployments (failed)', [['sp', 'identity'], ['evil', 'source'], ['ai', 'target']], ['2026-09-17T08:30:00Z'])
event('f6', 'variable viewed api', [['user', 'actor'], ['evil', 'source'], ['repo', 'target']], ['2026-09-18T09:00:00Z', '2026-09-18T09:01:00Z'])
event('f7', 'repository file accessed api', [['user', 'actor'], ['evil', 'source'], ['repo', 'target'], ['env', 'target']], ['2026-09-18T09:05:00Z'])
event('f8', 'signed in', [['sp', 'identity'], ['legit', 'source'], ['arm', 'target']], ['2026-09-20T10:00:00Z'])
entity('cred2', 'clientSecret k2', 'Credential', [['entra-credential-key-id', 'k2']])
event('f9', 'sign-in failed (7000215)', [['cred2', 'tool'], ['evil', 'source'], ['arm', 'target']], ['2026-09-17T09:00:00Z'])
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
const mark = { type: 'entity.update', payload: { id: 'cred', compromise: { from: '2026-09-15T00:00:00Z', note: 'leaked in CI log' } } }
validateDrafts(project('b', ops).data, [mark])
assert.throws(() => validateDrafts(project('b', ops).data, [{ type: 'entity.update', payload: { id: 'cred', compromise: { from: '2026-09-15', to: '2026-09-01' } } }]), /after its start/)
act(mark.type, mark.payload)
let data = project('b', ops).data
assert.deepEqual(data.entities.find(e => e.id === 'cred').compromise, { from: '2026-09-15T00:00:00.000Z', to: null, note: 'leaked in CI log', by: 'Analyst', at: '2026-10-04T00:00:00Z' })
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
  { sp: ['2026-09-01T08:20:00Z', 'evil', 'f4'], user: ['2026-09-18T09:00:00Z', 'evil', 'f6'] },
  'the service principal and the GitLab account; not the explicitly marked secret, not targets, not the key of a failed sign-in, not the legitimate IP')
impact = analyzeImpact(data)
assert.equal(impact.seeds.find(s => s.entity.id === 'sp').derived.at, '2026-09-01T08:20:00Z')
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
assert.equal(impact.first, '2026-09-01T08:20:00Z')
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
assert.equal(impact.rotation.find(r => /client secret/.test(r.title)).lastUse, '2026-09-17T08:00:00Z', "the secret's last successful use by the attacker")
// GitLab: the projects whose variables were read, with the groups they inherit from, and a script to list the keys.
assert.deepEqual(impact.variables.map(v => [v.path, v.groups, v.count]), [['grp/sub/proj', ['grp', 'grp/sub'], 2]])
const script = variableListingScript(impact.variables)
assert.match(script, /for p in 'grp\/sub\/proj'; do/); assert.match(script, /for g in 'grp' 'grp\/sub'; do/)

// 3. Rotation by hand: before the attacker's last use it has to be repeated.
act('entity.update', { id: 'st', rotated_at: '2026-09-17T08:00:00Z' })
impact = analyzeImpact(project('b', ops).data)
assert.equal(impact.rotation.find(r => /storage keys/.test(r.title)).stale, true)
act('entity.update', { id: 'st', rotated_at: null })
// 4. Rotation proven by an import: the key removed in AuditLogs, storage keys regenerated in AzureActivity.
entity('admin', 'admin@contoso.example', 'User')
event('r1', 'credential removed', [['admin', 'actor'], ['cred', 'target']], ['2026-09-25T10:00:00Z'])
event('r2', 'regeneratekey storage/storageaccounts', [['admin', 'actor'], ['st', 'target']], ['2026-09-16T10:00:00Z'])
event('r3', 'credential removed (failed)', [['admin', 'actor'], ['cred2', 'target']], ['2026-09-25T10:00:00Z'])
impact = analyzeImpact(project('b', ops).data)
const item = pattern => impact.rotation.find(r => pattern.test(r.title))
assert.deepEqual([item(/client secret/).proof, item(/client secret/).rotatedAt, item(/client secret/).stale], [{ at: '2026-09-25T10:00:00Z', fact: 'r1', operation: 'credential removed' }, '2026-09-25T10:00:00Z', false])
assert.equal(item(/storage keys/).stale, true, 'regenerated before the attacker listed the keys again: not enough')
event('r4', 'regeneratekey storage/storageaccounts', [['admin', 'actor'], ['st', 'target']], ['2026-09-26T10:00:00Z'])
impact = analyzeImpact(project('b', ops).data)
assert.deepEqual([item(/storage keys/).proof.at, item(/storage keys/).stale], ['2026-09-26T10:00:00Z', false], 'the latest proof counts (the same activity again: more evidence on it)')
assert.ok(!rotationProofs(project('b', ops).data).has('cred2'), 'a failed removal proves nothing')
// A compromised service principal is rotated once every compromised credential seen with it is removed.
act('entity.update', { id: 'sp', compromise: { from: '2026-09-15T00:00:00Z' } })
impact = analyzeImpact(project('b', ops).data)
assert.deepEqual([item(/all credentials of deploy-bot/).proof?.fact, item(/all credentials of deploy-bot/).stale], ['r1', false])
act('entity.update', { id: 'sp', compromise: { cleared: true } })
// An attacker-added credential is a backdoor to remove.
entity('backdoor', 'clientSecret k9', 'Credential', [['entra-credential-key-id', 'k9']])
event('b1', 'credential added', [['user', 'actor'], ['evil', 'source'], ['backdoor', 'target']], ['2026-09-18T10:00:00Z'])
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
act('entity.update', { id: 'sp', compromise: { from: '2026-09-15T00:00:00Z' } })
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
  const add = (type, payload) => more.push({ id: `s${++n}`, clock: n, at: '2026-10-04T00:00:00Z', actor: 'me', author: 'Analyst', boardId: 'c', type, payload })
  const ent = (id, kind, name = id) => add('entity.add', { id, name, kind })
  const ev = (id, predicate, parts, items) => { add('fact.add', { id, predicate, participants: parts.map(([entity_id, role]) => ({ entity_id, role })) })
    items.forEach(([t, note, locator, observation], i) => add('assertion.add', { id: `${id}-${i}`, fact_id: id, stance: 'supports', valid_from: t, note: note ?? 'row', locator, observation, source_id: null })) }
  ent('alice', 'User', 'alice@contoso.example'); ent('attacker', 'IP', '198.51.100.7'); ent('home', 'IP', '203.0.113.30'); ent('proxy', 'IP', '198.51.100.9')
  ent('e1', 'IP', '192.0.2.1'); ent('e2', 'IP', '192.0.2.2'); ent('portal', 'Service'); ent('vault', 'Key Vault'); ent('st2', 'Azure Resource'); ent('ci', 'Credential', 'clientSecret c-1')
  ent('runner', 'IP', '203.0.113.40'); ent('repo', 'Repository', 'team/app'); ent('sp2', 'Service Principal', 'deploy-2')
  // Theft: alice's token first from her home IP, then from the attacker.
  ev('t1', 'signed in', [['alice', 'identity'], ['home', 'source'], ['portal', 'target']], [['2026-09-20T10:00:00Z', '{"UniqueTokenIdentifier": "tokenAAAA1111bbbb"}']])
  ev('t2', 'write keyvault/vaults', [['alice', 'identity'], ['attacker', 'source'], ['vault', 'target']], [['2026-09-20T11:00:00Z', '{"Claims": {"uti": "tokenAAAA1111bbbb"}}', 'AzureActivity CorrelationId=c-9 EventDataId=e-9']])
  // Redirector: another token from the attacker first, then from a second IP.
  ev('t3', 'signed in', [['alice', 'identity'], ['attacker', 'source'], ['portal', 'target']], [['2026-09-21T08:00:00Z', '{"UniqueTokenIdentifier": "tokenCCCC2222dddd"}']])
  ev('t4', 'signed in', [['alice', 'identity'], ['proxy', 'source'], ['portal', 'target']], [['2026-09-21T09:00:00Z', '{"UniqueTokenIdentifier": "tokenCCCC2222dddd"}']])
  // Replay without a known attacker.
  ev('t5', 'signed in', [['alice', 'identity'], ['e1', 'source'], ['portal', 'target']], [['2026-09-22T08:00:00Z', '{"UniqueTokenIdentifier": "tokenEEEE3333ffff"}']])
  ev('t6', 'signed in', [['alice', 'identity'], ['e2', 'source'], ['portal', 'target']], [['2026-09-22T08:05:00Z', '{"UniqueTokenIdentifier": "tokenEEEE3333ffff"}']])
  // Likely regular: the stolen secret listed the keys from the usual runner before the compromise too.
  ev('r1', 'listkeys storage/storageaccounts', [['ci', 'tool'], ['runner', 'source'], ['st2', 'target']], [['2026-09-10T06:00:00Z', null, null, 'listkeys · ASN 64500'], ['2026-09-16T06:00:00Z']])
  // New IPs after the compromise: one from the provider the secret always came from, one from elsewhere.
  ent('cloud', 'IP', '203.0.113.41'); ent('odd', 'IP', '192.0.2.99')
  ev('n1', 'signed in', [['ci', 'tool'], ['cloud', 'source'], ['portal', 'target']], [['2026-09-17T06:00:00Z', null, null, 'signed in · ASN 64500']])
  ev('n2', 'signed in', [['ci', 'tool'], ['odd', 'source'], ['portal', 'target']], [['2026-09-17T07:00:00Z', null, null, 'signed in · ASN 65001']])
  // Trace back: the attacker reads CI/CD variables, then a service principal shows up from the attacker IP.
  ev('v1', 'variable viewed api', [['attacker', 'source'], ['repo', 'target']], [['2026-09-19T07:00:00Z']])
  ev('d1', 'signed in', [['sp2', 'identity'], ['attacker', 'source'], ['portal', 'target']], [['2026-09-19T09:00:00Z']])
  add('entity.update', { id: 'attacker', compromise: {} })
  add('entity.update', { id: 'ci', compromise: { from: '2026-09-15T00:00:00Z' } })
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
  assert.deepEqual([trace.derived, trace.at, trace.exposedBy[0].operation], [true, '2026-09-19T09:00:00Z', 'variable viewed api'])
  const advice = adviceFor(data, impact)
  const a = id => advice.find(x => x.id === id)
  assert.deepEqual(a('uti-tokenCCCC2222dddd').mark, ['proxy']); assert.equal(a('uti-tokenCCCC2222dddd').severity, 'high')
  assert.match(a('uti-tokenAAAA1111bbbb').title, /stolen from 203\.0\.113\.30/)
  assert.match(a('trace-sp2').title, /deploy-2 was probably taken from: variable viewed api/)
  assert.ok(a('confirm-derived').confirm.includes('sp2'))
  assert.ok(!advice.some(x => x.id === 'pivot-runner'), 'the usual runner is no attacker candidate')
  assert.deepEqual([a('pivot-cloud').severity, a('pivot-cloud').title], ['info', '203.0.113.41: new IP, but the usual provider (AS64500)'])
  assert.equal(a('pivot-odd').severity, 'medium', 'a new provider, but little history to compare with')
  assert.match(a('pivot-odd').detail, /AS65001 was not seen with it before/); assert.match(a('pivot-odd').detail, /Only 1 event before the compromise/)
  assert.equal(advice[0].severity, 'high')
  // The session query names the tokens; KQL for one evidence item finds the original row.
  const queries = huntingQueries(data, impact)
  assert.match(queries.find(q => q.id === 'session-replay').query, /"tokenCCCC2222dddd"/)
  assert.equal(evidenceQuery({ locator: 'AzureActivity CorrelationId=c-9 EventDataId=e-9', valid_from: '2026-09-20T11:00:00Z', source_id: null }, []),
    'AzureActivity\n| where TimeGenerated between (datetime(2026-09-20T11:00:00Z) - 10m .. datetime(2026-09-20T11:00:00Z) + 10m)\n| where CorrelationId == "c-9" and EventDataId == "e-9"')
  assert.match(evidenceQuery({ locator: 'GitLab audit events id=42', valid_from: '2026-09-20T11:00:00Z', source_id: 'g' }, [{ id: 'g', title: 'GitLab audit events (GitLab) · x.csv', excerpt: '[{"Type": "GitLabAudit_CL"}]' }]), /^GitLabAudit_CL\n.*\n\| where id == "42"$/)
  assert.match(evidenceQuery({ locator: 'Entra credential changes CorrelationId=c1 KeyId=k', valid_from: '2026-09-25T10:00:00Z', source_id: null }, []), /^AuditLogs\n.*\n\| where CorrelationId == "c1"$/)
}
console.log('Impact: compromise windows, derived compromise, attacker activities, effects, pivots, attack path, rotation with proof, CI/CD variables, hunting queries and report passed')
