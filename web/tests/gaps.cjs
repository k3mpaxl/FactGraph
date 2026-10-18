const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { boardGaps, neighborhood, GAP_URI } = require(path + '/gaps.js')

// A small incident: a user known only by its object ID signs in from the attacker's IP to an app, a device whose
// process connected out (its launch is not on the board), and a service principal with an app ID.
let clock = 0
const ops = []
const act = (type, payload) =>
  ops.push({ id: `a${++clock}`, clock, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'b', type, payload })
const entity = (id, name, kind, identifiers = []) => {
  act('entity.add', { id, name, kind })
  identifiers.forEach(([namespace, value, scheme = 'external_id'], i) =>
    act('identifier.add', { id: `${id}-i${i}`, entity_id: id, scheme, namespace, raw_value: value, normalized_value: value }),
  )
}
const activity = (id, predicate, participants, note, at) => {
  act('fact.add', { id, predicate, participants: participants.map(([entity_id, role]) => ({ entity_id, role })) })
  act('assertion.add', { id: `${id}-e`, fact_id: id, stance: 'supports', valid_from: at, note: JSON.stringify(note), source_id: null })
}
const oid = '11111111-2222-3333-4444-555555555555'
entity('user', oid, 'User', [['entra-object-id', oid]])
entity('evil', '198.51.100.7', 'IP')
entity('app', 'Azure Portal', 'Service', [['entra-app-id', 'c44b4083-3bb0-49c1-b47d-974e53cbdf3c']])
entity('ws', 'ws-0142.corp.example', 'Device', [['mde-device-id', 'dev-0142']])
entity('ps', 'powershell.exe', 'Process')
entity('sp', 'deploy-bot', 'Service Principal', [['entra-object-id', '0b7f0c1e-1111-4222-8333-444444444444']])
entity('quiet', 'unrelated.example', 'Domain')
activity(
  'signin',
  'signed in',
  [
    ['user', 'identity'],
    ['evil', 'source'],
    ['app', 'target'],
  ],
  { UniqueTokenIdentifier: 'tokenAAAA1111bbbb' },
  '2026-10-01T10:00:00Z',
)
activity(
  'connect',
  'connection success',
  [
    ['ws', 'source'],
    ['ps', 'via'],
    ['evil', 'target'],
  ],
  { DeviceId: 'DEV-0142', InitiatingProcessUniqueId: 200 },
  '2026-10-01T10:05:00Z',
)
activity(
  'sp-signin',
  'signed in',
  [
    ['sp', 'identity'],
    ['evil', 'source'],
    ['app', 'target'],
  ],
  { ServicePrincipalId: 'x' },
  '2026-10-01T10:10:00Z',
)
act('entity.update', { id: 'evil', compromise: {} })
const data = project('b', ops).data

{
  const { gaps, answered } = boardGaps(data)
  const byRule = Object.fromEntries(gaps.map(g => [g.rule, g]))
  assert.deepEqual(answered, [])
  // Who is the user known only by its ID: urgent, IdentityInfo by object ID, imported by the IdentityInfo mapping.
  const identity = byRule['identity-info']
  assert.deepEqual(
    [identity.priority, identity.entities, identity.imports_as, identity.platform],
    ['high', ['user'], 'IdentityInfo', 'defender'],
  )
  assert.ok(identity.query.includes(`AccountObjectId in~ (dynamic(["${oid}"]))`))
  assert.match(identity.id, /^identity-info:[0-9a-f]{12}$/)
  // The device: by its Defender ID, one row per public IP.
  const device = byRule['device-info']
  assert.deepEqual(device.entities, ['ws'])
  assert.ok(device.query.includes('DeviceId in~ (dynamic(["dev-0142"]))') && device.query.includes('by DeviceId, PublicIP'))
  // The process that connected out: its launch by device and start key, in a window around the activity.
  const launch = byRule['process-launch']
  assert.deepEqual([launch.priority, launch.entities], ['high', ['dev-0142|200']])
  assert.ok(launch.query.startsWith('let start = datetime(2026-09-24T10:05:00.000Z);'))
  assert.ok(launch.query.includes('in (dynamic(["dev-0142|200"]))'))
  // The service principal and the app: OAuthAppInfo by app ID and service principal object ID.
  const app = byRule['app-info']
  assert.deepEqual(app.entities.sort(), ['app', 'sp'])
  assert.ok(app.query.includes('OAuthAppId in~') && app.query.includes('ServicePrincipalId in~'))
  // Open hunts of the attack impact come last among equals; every gap has KQL.
  assert.ok(gaps.some(g => g.rule === 'hunt' && g.id.startsWith('hunt:ip-everywhere:')))
  assert.ok(gaps.every(g => g.query.length > 20 && g.question && g.why))
  assert.equal(gaps[0].priority, 'high')
  assert.ok(!gaps.some(g => g.entities.includes('quiet')), 'only what the attack touches')

  // What the identities did, as original rows: sign-ins of the service principal, Azure operations and Graph calls of
  // the user and the service principal, two weeks before the first evidence; the summarising hunts for them are left out.
  const signins = byRule['sp-signins']
  assert.deepEqual([signins.entities, signins.imports_as, signins.platform], [['sp'], 'AADServicePrincipalSignInLogs', 'sentinel'])
  assert.ok(signins.query.includes('ServicePrincipalId in~ (dynamic(["0b7f0c1e-1111-4222-8333-444444444444"]))'))
  assert.ok(signins.query.startsWith('let start = datetime(2026-09-17T10:10:00.000Z);') && signins.query.endsWith('| take 20000'))
  assert.deepEqual(byRule['azure-activity'].entities.sort(), ['sp', 'user'])
  assert.ok(byRule['azure-activity'].query.includes(`Caller in~ (dynamic(["${oid}", "0b7f0c1e-1111-4222-8333-444444444444"]))`))
  const graphGap = byRule['graph-activity']
  assert.ok(graphGap.query.includes(`UserId in~ (dynamic(["${oid}"]))`) && graphGap.query.includes('ServicePrincipalId in~'))
  assert.equal(byRule['aad-graph-activity'].priority, 'high', 'the service principal signed in from the attacker IP: derived compromised')
  assert.ok(!gaps.some(g => /^hunt:(sp-signins|sp-azure|sp-graph):/.test(g.id)))
  // Rows from a table on the board cover the identity for it, also from a dropped export.
  {
    const more = [...ops]
    more.push({
      id: 'z1',
      clock: 950,
      at: '2026-10-04T00:00:00.000Z',
      actor: 'me',
      author: 'Analyst',
      boardId: 'b',
      type: 'fact.add',
      payload: {
        id: 'arm',
        predicate: 'listkeys storage',
        participants: [
          { entity_id: 'user', role: 'identity' },
          { entity_id: 'evil', role: 'source' },
        ],
      },
    })
    more.push({
      id: 'z2',
      clock: 951,
      at: '2026-10-04T00:00:00.000Z',
      actor: 'me',
      author: 'Analyst',
      boardId: 'b',
      type: 'assertion.add',
      payload: {
        id: 'arm-e',
        fact_id: 'arm',
        stance: 'supports',
        valid_from: '2026-10-01T11:00:00Z',
        note: '{}',
        locator: 'AzureActivity CorrelationId=c1',
        source_id: null,
      },
    })
    const covered = boardGaps(project('b', more).data).gaps.find(g => g.rule === 'azure-activity')
    assert.deepEqual(covered.entities, ['sp'], 'the user has AzureActivity rows now')
  }

  // An answer on the board (a source with the gap's URI) closes it for every browser; a new user opens a new gap.
  const answer = (gap, extra = {}) => ({
    id: `s${++clock}`,
    clock,
    at: '2026-10-04T00:00:00.000Z',
    actor: 'agent',
    author: 'Agent',
    boardId: 'b',
    type: 'source.add',
    payload: {
      id: `answer-${gap.rule}`,
      title: 'Answer',
      uri: GAP_URI + gap.id,
      excerpt: JSON.stringify({ gap: gap.id, rule: gap.rule, entities: gap.entities, rows: 0, note: 'nothing', ...extra }),
    },
  })
  const closed = project('b', [...ops, answer(identity), answer(launch)]).data
  const after = boardGaps(closed)
  assert.ok(!after.gaps.some(g => g.rule === 'identity-info' || g.rule === 'process-launch'))
  assert.deepEqual(after.answered.map(a => [a.rule, a.entities]).sort(), [
    ['identity-info', ['user']],
    ['process-launch', ['dev-0142|200']],
  ])
  const second = [...ops, answer(identity)]
  second.push({
    id: 'x1',
    clock: 900,
    at: '2026-10-04T00:00:00.000Z',
    actor: 'me',
    author: 'Analyst',
    boardId: 'b',
    type: 'entity.add',
    payload: { id: 'user2', name: 'eve@contoso.example', kind: 'User' },
  })
  second.push({
    id: 'x2',
    clock: 901,
    at: '2026-10-04T00:00:00.000Z',
    actor: 'me',
    author: 'Analyst',
    boardId: 'b',
    type: 'identifier.add',
    payload: {
      id: 'u2i',
      entity_id: 'user2',
      scheme: 'email',
      namespace: '',
      raw_value: 'eve@contoso.example',
      normalized_value: 'eve@contoso.example',
    },
  })
  second.push({
    id: 'x3',
    clock: 902,
    at: '2026-10-04T00:00:00.000Z',
    actor: 'me',
    author: 'Analyst',
    boardId: 'b',
    type: 'fact.add',
    payload: {
      id: 'f2',
      predicate: 'signed in',
      participants: [
        { entity_id: 'user2', role: 'identity' },
        { entity_id: 'evil', role: 'source' },
      ],
    },
  })
  const reopened = boardGaps(project('b', second).data).gaps.find(g => g.rule === 'identity-info')
  assert.deepEqual(reopened.entities, ['user2'], 'only the user not answered yet')
  assert.ok(reopened.query.includes('AccountUpn in~ (dynamic(["eve@contoso.example"]))'))
  assert.notEqual(reopened.id, identity.id)
}

{
  // The neighbourhood: one hop from the user is the sign-in with its IP and app; two hops add what else touched them.
  const one = neighborhood(data, 'user', 1)
  assert.deepEqual(one.entities.map(e => e.id).sort(), ['app', 'evil', 'user'])
  assert.deepEqual(
    one.relations.map(r => [r.id, r.evidence, r.first]),
    [['signin', 1, '2026-10-01T10:00:00.000Z']],
  )
  assert.ok(one.entities.find(e => e.id === 'evil').compromise, 'compromise marks come along')
  const two = neighborhood(data, 'user', 2)
  assert.deepEqual(two.relations.map(r => r.id).sort(), ['connect', 'signin', 'sp-signin'])
  assert.equal(neighborhood(data, 'nobody'), null)
  assert.equal(neighborhood(data, 'user', 9).hops, 3)
}
console.log(
  'Gaps: identity, device, app, process launch, sign-ins, Azure and Graph activity, hunts, answers, reopening; neighbourhood passed',
)
