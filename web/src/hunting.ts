import type { Entity, GraphData } from './types'
import { analyzeImpact, compromiseOf, sessionFindings, type Impact } from './impact'

/**
 * KQL for Microsoft Sentinel / Log Analytics that shows how far the attacker got: filled with the IDs, IPs, resources
 * and time window from the board. Each query says why it matters; queries for tables already imported are marked, so
 * the analyst sees what is still missing.
 */
/** importable: the result can be exported as CSV and dropped on the board (named after the mapping that reads it). */
export type HuntQuery = { id: string; title: string; why: string; query: string; tables: string[]; imported: boolean; importable?: string }

const literal = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const list = (values: string[]) => `dynamic([${values.map(literal).join(', ')}])`
const ident = (entity: Entity, ...names: string[]) => entity.identifiers.filter(i => names.includes(i.namespace) || names.includes(i.scheme)).map(i => i.normalized_value)
const isKind = (entity: Entity, pattern: RegExp) => pattern.test(entity.kind)
const MAX_VALUES = 200

/** Tables the board already has rows from: the import title ("AzureActivity (Sentinel) · file") and the rows' Type column. */
export function importedTables(data: Pick<GraphData, 'sources'>): Set<string> {
  const tables = new Set<string>()
  for (const source of data.sources) {
    const title = /^([A-Za-z][\w]*)\s*\(/.exec(source.title)?.[1]
    if (title) tables.add(title)
    const type = /"Type":\s*"([A-Za-z][\w]*)"/.exec(source.excerpt.slice(0, 4000))?.[1]
    if (type) tables.add(type)
  }
  return tables
}

/** The custom table GitLab audit events were exported from, if the board has them. */
function gitlabTable(data: Pick<GraphData, 'sources'>): string | null {
  for (const source of data.sources) {
    if (!/gitlab/i.test(source.title)) continue
    const type = /"Type":\s*"([A-Za-z][\w]*)"/.exec(source.excerpt.slice(0, 4000))?.[1]
    if (type) return type
  }
  return null
}

export function huntingQueries(data: Pick<GraphData, 'entities' | 'sources'>, impact: Impact): HuntQuery[] {
  if (!impact.seeds.length) return []
  const imported = importedTables(data)
  const queries: HuntQuery[] = []
  // A derived compromise is known from its first use on; hunt two weeks earlier to find when it really started.
  const DAY = 86_400_000
  const froms = impact.seeds.map(s => s.derived ? new Date(Date.parse(s.derived.at) - 14 * DAY).toISOString() : compromiseOf(s.entity)?.from).filter((t): t is string => !!t).sort()
  const tos = impact.seeds.map(s => compromiseOf(s.entity)?.to)
  const start = froms[0] ? `datetime(${froms[0]})` : impact.first ? `datetime(${impact.first}) - 1d` : 'ago(30d)'
  const end = tos.length && tos.every(Boolean) ? `datetime(${(tos as string[]).sort().at(-1)})` : 'now()'
  const window = `let start = ${start};\nlet end = ${end};\n`
  const add = (id: string, title: string, why: string, tables: string[], query: string, importable?: string) =>
    queries.push({ id, title, why, query: window + query, tables, imported: tables.some(t => imported.has(t)), ...(importable ? { importable } : {}) })

  const seeds = impact.seeds.map(s => s.entity)
  const newPivots = impact.pivots.filter(p => !p.before).map(p => p.entity)
  const principals = [...seeds, ...newPivots].filter(e => isKind(e, /service principal|application|managed identity|workload/i))
  const oids = [...new Set(principals.flatMap(e => ident(e, 'entra-object-id')))].slice(0, MAX_VALUES)
  const appIds = [...new Set(principals.flatMap(e => ident(e, 'entra-app-id')))].slice(0, MAX_VALUES)
  const keyIds = [...new Set(seeds.flatMap(e => ident(e, 'entra-credential-key-id')))].slice(0, MAX_VALUES)
  const users = [...seeds, ...newPivots].filter(e => isKind(e, /^user|account/i))
  const upns = [...new Set(users.flatMap(e => ident(e, 'email')).concat(users.filter(e => e.name.includes('@')).map(e => e.name.toLowerCase())))].slice(0, MAX_VALUES)
  const ips = [...new Set([...seeds, ...newPivots].filter(e => isKind(e, /^ip\b|ip address/i)).map(e => ident(e, 'ip')[0] ?? e.name))].slice(0, MAX_VALUES)

  if (keyIds.length) {
    const principalNames = [...new Set(principals.map(e => e.name))].slice(0, MAX_VALUES)
    add('rotation-proof', 'Prove the rotation: were the stolen keys removed?',
      'Every secret and certificate removed from or added to the affected app registrations and service principals since the attack (AuditLogs, one row per key). Export as CSV and drop it here: removed keys tick off the rotation list, keys added during the attack show up as backdoors to remove.',
      ['AuditLogs'],
      `let keys = ${list(keyIds)};\nlet names = ${list(principalNames)};\nlet changes = AuditLogs\n    | where TimeGenerated between (start .. now())\n    | where OperationName has_any ("Certificates and secrets management", "service principal credentials", "Update application", "Update service principal")\n    | mv-expand Target = TargetResources\n    | mv-expand Property = Target.modifiedProperties\n    | where tostring(Property.displayName) == "KeyDescription"\n    | extend Old = tostring(Property.oldValue), New = tostring(Property.newValue)\n    | extend OldKeys = extract_all(@"KeyIdentifier=([0-9a-fA-F-]{36})", Old), NewKeys = extract_all(@"KeyIdentifier=([0-9a-fA-F-]{36})", New)\n    | extend Removed = set_difference(OldKeys, NewKeys), Added = set_difference(NewKeys, OldKeys)\n    | extend Application = tostring(Target.displayName), ApplicationObjectId = tostring(Target.id);\nlet apps = changes | where Old has_any (keys) or New has_any (keys) or Application in (names) | distinct ApplicationObjectId;\nunion\n    (changes | mv-expand KeyId = Removed to typeof(string) | extend CredentialChange = "removed", Description = Old),\n    (changes | mv-expand KeyId = Added to typeof(string) | extend CredentialChange = "added", Description = New)\n| where ApplicationObjectId in (apps) and isnotempty(KeyId)\n| extend KeyType = extract(strcat(@"KeyIdentifier=", KeyId, @",\\s*KeyType=(\\w+)"), 1, Description), KeyName = extract(strcat(@"KeyIdentifier=", KeyId, @"[^\\]]*DisplayName=([^\\]]*)"), 1, Description)\n| project TimeGenerated, CredentialChange, KeyId, KeyType, KeyName, Application, ApplicationObjectId,\n    Actor = coalesce(tostring(InitiatedBy.user.userPrincipalName), tostring(InitiatedBy.app.displayName)), ActorId = coalesce(tostring(InitiatedBy.user.id), tostring(InitiatedBy.app.servicePrincipalId)),\n    ActorIp = tostring(InitiatedBy.user.ipAddress), OperationName, Result, CorrelationId\n| order by TimeGenerated asc`, 'Entra credential changes')
    add('credential-use', 'Where else was the stolen credential used, and is it still accepted?',
      'Every sign-in with the stolen secret or certificate until now. New IPs and resources show the attacker beyond the board; after the rotation only failed attempts may remain. Export as CSV and drop it here to add them to the graph.', ['AADServicePrincipalSignInLogs'],
      `AADServicePrincipalSignInLogs\n| where TimeGenerated between (start .. now())\n| where ServicePrincipalCredentialKeyId in (${list(keyIds)})\n| project TimeGenerated, ServicePrincipalName, ServicePrincipalId, AppId, ServicePrincipalCredentialKeyId, ServicePrincipalCredentialThumbprint, ClientCredentialType,\n    IPAddress, Location, LocationDetails, AutonomousSystemNumber, NetworkLocationDetails, ResourceDisplayName, ResourceIdentity, ResourceServicePrincipalId, ResultType, UserAgent, CorrelationId, Id\n| order by TimeGenerated asc`, 'AADServicePrincipalSignInLogs')
  }
  if (oids.length || appIds.length) {
    const spFilter = [oids.length && `ServicePrincipalId in (${list(oids)})`, appIds.length && `AppId in (${list(appIds)})`].filter(Boolean).join(' or ')
    add('sp-signins', 'All sign-ins of the service principal', 'Which IPs, credentials and resources it used since the compromise; an IP or key ID you do not know is the next pivot.', ['AADServicePrincipalSignInLogs'],
      `AADServicePrincipalSignInLogs\n| where TimeGenerated between (start .. end)\n| where ${spFilter}\n| summarize SignIns = count(), Resources = make_set(ResourceDisplayName, 50), First = min(TimeGenerated), Last = max(TimeGenerated)\n    by IPAddress, Location, ServicePrincipalCredentialKeyId, ResultType\n| order by First asc`)
    if (oids.length) add('sp-azure', 'Everything it did in Azure', 'All control-plane operations by the service principal: reading keys (listKeys, listCredentials) and changes are the impact.', ['AzureActivity'],
      `AzureActivity\n| where TimeGenerated between (start .. end)\n| where Caller in~ (${list(oids)})\n| summarize Count = count(), Resources = make_set(_ResourceId, 100), First = min(TimeGenerated), Last = max(TimeGenerated)\n    by OperationNameValue, ActivityStatusValue, CallerIpAddress\n| order by First asc`)
    if (appIds.length || oids.length) add('sp-keyvault', 'Key Vault secrets it read', 'SecretGet, KeyGet and CertificateGet show which secrets left the vault; each one has to be rotated at its origin.', ['AzureDiagnostics'],
      `AzureDiagnostics\n| where TimeGenerated between (start .. end)\n| where ResourceProvider == "MICROSOFT.KEYVAULT"\n| where ${[appIds.length && `identity_claim_appid_g in (${list(appIds)})`, oids.length && `identity_claim_http_schemas_microsoft_com_identity_claims_objectidentifier_g in (${list(oids)})`].filter(Boolean).join(' or ')}${ips.length ? ` or CallerIPAddress in (${list(ips)})` : ''}\n| summarize Count = count(), Items = make_set(requestUri_s, 100), First = min(TimeGenerated), Last = max(TimeGenerated) by Resource, OperationName, CallerIPAddress, ResultSignature\n| order by First asc`)
    if (appIds.length || oids.length) add('sp-graph', 'Microsoft Graph calls', 'Directory reads and changes through Graph (users, apps, mail) that never appear in AzureActivity.', ['MicrosoftGraphActivityLogs'],
      `MicrosoftGraphActivityLogs\n| where TimeGenerated between (start .. end)\n| where ${[appIds.length && `AppId in (${list(appIds)})`, oids.length && `ServicePrincipalId in (${list(oids)})`].filter(Boolean).join(' or ')}\n| extend Path = tostring(split(tostring(parse_url(RequestUri).Path), "?")[0])\n| summarize Calls = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by RequestMethod, Path, ResponseStatusCode, IPAddress\n| order by Calls desc`)
    add('sp-persistence', 'Persistence: credentials, owners and roles added', 'An attacker keeps access by adding a secret, a federated credential, an owner or a role assignment; these survive the rotation.', ['AuditLogs', 'AzureActivity'],
      `let ids = ${list([...oids, ...appIds])};\nunion isfuzzy=true\n  (AuditLogs\n   | where TimeGenerated between (start .. end)\n   | where OperationName has_any ("credential", "certificates and secrets", "owner", "app role assignment", "federated", "consent")\n   | where tostring(TargetResources) has_any (ids) or tostring(InitiatedBy) has_any (ids)\n   | project TimeGenerated, Table = "AuditLogs", Operation = OperationName, Actor = coalesce(tostring(InitiatedBy.app.displayName), tostring(InitiatedBy.user.userPrincipalName)), Target = tostring(TargetResources[0].displayName), Result),\n  (AzureActivity\n   | where TimeGenerated between (start .. end)\n   | where OperationNameValue has_any ("roleAssignments/write", "roleDefinitions/write", "federatedIdentityCredentials/write")\n   | where Caller in~ (ids) or tostring(Properties) has_any (ids)\n   | project TimeGenerated, Table = "AzureActivity", Operation = OperationNameValue, Actor = Caller, Target = _ResourceId, Result = ActivityStatusValue)\n| order by TimeGenerated asc`)
  }
  if (upns.length) add('user-activity', 'What the compromised user did', 'Interactive and token sign-ins, directory changes and Microsoft 365 activity of the account.', ['SigninLogs', 'AADNonInteractiveUserSignInLogs', 'AuditLogs', 'OfficeActivity'],
    `let upns = ${list(upns)};\nunion isfuzzy=true\n  (SigninLogs | where TimeGenerated between (start .. end) | where UserPrincipalName in~ (upns) | project TimeGenerated, Table = "SigninLogs", What = AppDisplayName, IP = IPAddress, Result = ResultType),\n  (AADNonInteractiveUserSignInLogs | where TimeGenerated between (start .. end) | where UserPrincipalName in~ (upns) | project TimeGenerated, Table = "AADNonInteractiveUserSignInLogs", What = AppDisplayName, IP = IPAddress, Result = ResultType),\n  (AuditLogs | where TimeGenerated between (start .. end) | where tostring(InitiatedBy.user.userPrincipalName) in~ (upns) | project TimeGenerated, Table = "AuditLogs", What = OperationName, IP = tostring(InitiatedBy.user.ipAddress), Result),\n  (OfficeActivity | where TimeGenerated between (start .. end) | where UserId in~ (upns) | project TimeGenerated, Table = "OfficeActivity", What = Operation, IP = ClientIP, Result = ResultStatus)\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Table, What, IP, Result\n| order by First asc`)
  if (ips.length) {
    const gitlab = gitlabTable(data)
    add('ip-everywhere', `Everything from the attacker's IP${ips.length === 1 ? '' : 's'}`, 'The same infrastructure across sign-ins, Azure, Key Vault, storage, Graph and GitLab: other identities used from it are compromised too.',
      ['SigninLogs', 'AADNonInteractiveUserSignInLogs', 'AADServicePrincipalSignInLogs', 'AzureActivity', 'AzureDiagnostics', 'StorageBlobLogs', 'MicrosoftGraphActivityLogs', 'OfficeActivity', ...(gitlab ? [gitlab] : [])],
      `let ips = ${list(ips)};\nunion isfuzzy=true\n  (SigninLogs | where TimeGenerated between (start .. end) | where IPAddress in (ips) | project TimeGenerated, Table = "SigninLogs", Identity = UserPrincipalName, What = AppDisplayName, IP = IPAddress),\n  (AADNonInteractiveUserSignInLogs | where TimeGenerated between (start .. end) | where IPAddress in (ips) | project TimeGenerated, Table = "AADNonInteractiveUserSignInLogs", Identity = UserPrincipalName, What = AppDisplayName, IP = IPAddress),\n  (AADServicePrincipalSignInLogs | where TimeGenerated between (start .. end) | where IPAddress in (ips) | project TimeGenerated, Table = "AADServicePrincipalSignInLogs", Identity = ServicePrincipalName, What = ResourceDisplayName, IP = IPAddress),\n  (AzureActivity | where TimeGenerated between (start .. end) | where CallerIpAddress in (ips) | project TimeGenerated, Table = "AzureActivity", Identity = Caller, What = OperationNameValue, IP = CallerIpAddress),\n  (AzureDiagnostics | where TimeGenerated between (start .. end) | where CallerIPAddress in (ips) | project TimeGenerated, Table = "AzureDiagnostics", Identity = coalesce(identity_claim_appid_g, identity_claim_upn_s), What = strcat(ResourceProvider, " ", OperationName), IP = CallerIPAddress),\n  (StorageBlobLogs | where TimeGenerated between (start .. end) | extend IP = tostring(split(CallerIpAddress, ":")[0]) | where IP in (ips) | project TimeGenerated, Table = "StorageBlobLogs", Identity = strcat(AccountName, " ", AuthenticationType), What = OperationName, IP),\n  (MicrosoftGraphActivityLogs | where TimeGenerated between (start .. end) | where IPAddress in (ips) | project TimeGenerated, Table = "MicrosoftGraphActivityLogs", Identity = coalesce(AppId, UserId), What = RequestMethod, IP = IPAddress),\n  (OfficeActivity | where TimeGenerated between (start .. end) | where ClientIP in (ips) | project TimeGenerated, Table = "OfficeActivity", Identity = UserId, What = Operation, IP = ClientIP)${gitlab ? `,\n  (${gitlab} | where TimeGenerated between (start .. end) | where ip_address in (ips) | project TimeGenerated, Table = "${gitlab}", Identity = author_name, What = tostring(parse_json(details).event_name), IP = ip_address)` : ''}\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Table, Identity, What, IP\n| order by First asc`)
  }

  const sessions = sessionFindings(data as Pick<GraphData, 'entities' | 'facts'>, impact).slice(0, MAX_VALUES)
  if (sessions.length) add('session-replay', 'Everything done with the replayed session tokens',
    'Every sign-in, Azure operation and Graph call made with the session tokens seen from more than one IP (Entra UniqueTokenIdentifier, the uti claim): each further IP is a redirector of the attacker, or the place the token was stolen from.',
    ['SigninLogs', 'AADNonInteractiveUserSignInLogs', 'AADServicePrincipalSignInLogs', 'AzureActivity', 'MicrosoftGraphActivityLogs'],
    `let utis = ${list(sessions.map(s => s.uti))};\nunion isfuzzy=true\n  (SigninLogs | where UniqueTokenIdentifier in (utis) | project TimeGenerated, Table = "SigninLogs", Session = UniqueTokenIdentifier, Identity = UserPrincipalName, IP = IPAddress, What = AppDisplayName),\n  (AADNonInteractiveUserSignInLogs | where UniqueTokenIdentifier in (utis) | project TimeGenerated, Table = "AADNonInteractiveUserSignInLogs", Session = UniqueTokenIdentifier, Identity = UserPrincipalName, IP = IPAddress, What = AppDisplayName),\n  (AADServicePrincipalSignInLogs | where UniqueTokenIdentifier in (utis) | project TimeGenerated, Table = "AADServicePrincipalSignInLogs", Session = UniqueTokenIdentifier, Identity = ServicePrincipalName, IP = IPAddress, What = ResourceDisplayName),\n  (AzureActivity | extend Session = tostring(parse_json(Claims).uti) | where Session in (utis) | project TimeGenerated, Table = "AzureActivity", Session, Identity = Caller, IP = CallerIpAddress, What = OperationNameValue),\n  (MicrosoftGraphActivityLogs | where SignInActivityId in (utis) | project TimeGenerated, Table = "MicrosoftGraphActivityLogs", Session = SignInActivityId, Identity = coalesce(UserId, AppId), IP = IPAddress, What = strcat(RequestMethod, " ", tostring(parse_url(RequestUri).Path)))\n| where TimeGenerated between (start .. now())\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Session, Identity, IP, Table, What\n| order by Session, First asc`)

  // Resources whose keys or credentials were read: was the stolen key used afterwards?
  const exposed = impact.impacted.filter(i => i.effect === 'secret')
  const byOperation = (pattern: RegExp) => exposed.filter(i => i.operations.some(o => pattern.test(o.operation.toLowerCase())))
  const resourceIds = (entries: typeof exposed) => [...new Set(entries.flatMap(i => ident(i.entity, 'resource_id')))].slice(0, MAX_VALUES)
  const firstOf = (entries: typeof exposed) => entries.map(i => i.first).filter((t): t is string => !!t).sort()[0]
  const since = (entries: typeof exposed) => { const t = firstOf(entries); return t ? `datetime(${t})` : 'start' }
  const aks = byOperation(/listcluster\w*credential/)
  if (aks.length) add('aks-admin', 'Was the stolen kubeconfig used?', 'listClusterAdminCredential hands out a cluster-admin certificate ("masterclient"); the Kubernetes audit log shows what was done with it.', ['AKSAudit', 'AKSAuditAdmin'],
    `let clusters = ${list(resourceIds(aks))};\nunion isfuzzy=true AKSAudit, AKSAuditAdmin\n| where TimeGenerated between (${since(aks)} .. end)\n| where _ResourceId in~ (clusters)\n| extend User = tostring(User.username), Resource = tostring(ObjectRef.resource), Namespace = tostring(ObjectRef.namespace)\n| where User in ("masterclient", "clusterAdmin", "clusterUser") or User startswith "system:serviceaccount:kube-system"\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by _ResourceId, User, Verb, Resource, Namespace, SourceIps = tostring(SourceIps)\n| order by First asc`)
  const acr = byOperation(/(containerregistry|registries).*listcredentials|listcredentials.*(containerregistry|registries)/)
  if (acr.length) add('acr-use', 'Was the registry password used?', 'Logins and pushes with the admin credentials after they were listed: a pushed image is a supply-chain foothold.', ['ContainerRegistryLoginEvents', 'ContainerRegistryRepositoryEvents'],
    `let registries = ${list(resourceIds(acr))};\nunion isfuzzy=true\n  (ContainerRegistryLoginEvents | where _ResourceId in~ (registries) | project TimeGenerated, Event = strcat("login ", ResultDescription), Identity, CallerIpAddress, Repository = ""),\n  (ContainerRegistryRepositoryEvents | where _ResourceId in~ (registries) | project TimeGenerated, Event = OperationName, Identity, CallerIpAddress, Repository = strcat(Repository, ":", Tag))\n| where TimeGenerated between (${since(acr)} .. end)\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Event, Identity, CallerIpAddress, Repository\n| order by First asc`)
  const storage = byOperation(/storage.*(listkeys|listaccountsas|listservicesas)|(listkeys|listaccountsas|listservicesas).*storage/)
  if (storage.length) add('storage-keys', 'Was the storage key used?', 'Requests authenticated with the account key or a SAS after the keys were listed; unknown IPs mean data access with the stolen key.', ['StorageBlobLogs', 'StorageFileLogs', 'StorageQueueLogs', 'StorageTableLogs'],
    `let accounts = ${list([...new Set(storage.map(i => i.entity.name.split('/').pop()!.toLowerCase()))])};\nunion isfuzzy=true StorageBlobLogs, StorageFileLogs, StorageQueueLogs, StorageTableLogs\n| where TimeGenerated between (${since(storage)} .. end)\n| where AccountName in~ (accounts) and AuthenticationType in ("AccountKey", "SAS")\n| extend IP = tostring(split(CallerIpAddress, ":")[0])\n| summarize Requests = count(), Operations = make_set(OperationName, 20), First = min(TimeGenerated), Last = max(TimeGenerated) by AccountName, AuthenticationType, IP\n| order by First asc`)
  const cognitive = byOperation(/cognitiveservices|openai/)
  if (cognitive.length) add('ai-keys', 'Were the AI service keys used?', 'Calls to the Cognitive Services / Azure OpenAI accounts after their keys were listed (e.g. model abuse, data access).', ['AzureDiagnostics'],
    `let accounts = ${list([...new Set(cognitive.map(i => i.entity.name.split('/').pop()!.toUpperCase()))])};\nAzureDiagnostics\n| where TimeGenerated between (${since(cognitive)} .. end)\n| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES" and Resource in (accounts)\n| summarize Calls = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Resource, OperationName, CallerIPAddress, ResultSignature\n| order by First asc`)
  const sites = byOperation(/web\/sites/)
  if (sites.length) add('app-publishing', 'Were publishing credentials or function keys used?', 'FTP / Web Deploy logins after the publish profile or keys were read: a changed deployment is code execution.', ['AppServiceAuditLogs', 'AzureActivity'],
    `let sites = ${list(resourceIds(sites))};\nunion isfuzzy=true\n  (AppServiceAuditLogs | where _ResourceId in~ (sites) | project TimeGenerated, Event = strcat(Protocol, " ", OperationName), Who = User, IP = UserAddress, Resource = _ResourceId),\n  (AzureActivity | where _ResourceId in~ (sites) | where OperationNameValue has_any ("sites/write", "deployments", "config/write", "slots") | project TimeGenerated, Event = OperationNameValue, Who = Caller, IP = CallerIpAddress, Resource = _ResourceId)\n| where TimeGenerated between (${since(sites)} .. end)\n| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated) by Event, Who, IP, Resource\n| order by First asc`)
  const touched = impact.impacted.filter(i => i.effect !== 'attempt' && ident(i.entity, 'resource_id').length)
  if (touched.length) add('resource-others', 'Who else touched the impacted resources?', 'Other callers on the same resources after the attacker: a second identity working with the same goal is likely compromised too.', ['AzureActivity'],
    `let resources = ${list(resourceIds(touched))};\nAzureActivity\n| where TimeGenerated between (start .. end)\n| where _ResourceId in~ (resources)${oids.length ? `\n| where Caller !in~ (${list(oids)})` : ''}\n| summarize Count = count(), Operations = make_set(OperationNameValue, 20), First = min(TimeGenerated), Last = max(TimeGenerated) by Caller, CallerIpAddress\n| order by First asc`)
  if (impact.variables.length) {
    const gitlab = gitlabTable(data)
    add('gitlab-projects', 'Who else worked in the exposed GitLab projects?', 'Pipelines, variable reads and git operations in the projects whose CI/CD variables the attacker read; the secrets in them reach further systems.', [gitlab ?? 'GitLab audit table'],
      `let projects = ${list(impact.variables.map(v => v.path).slice(0, MAX_VALUES))};\n${gitlab ?? 'GitLabAudit_CL /* replace with your GitLab audit table */'}\n| where TimeGenerated between (start .. end)\n| where entity_path in (projects)\n| extend Event = tostring(parse_json(details).event_name)\n| summarize Count = count(), Projects = dcount(entity_path), First = min(TimeGenerated), Last = max(TimeGenerated) by author_name, ip_address, Event\n| order by First asc`)
  }
  return queries
}

/** The impact as JSON for REST and MCP: names instead of IDs where it helps, lists capped and guidance shared, so replies stay small. */
export function impactReport(data: Pick<GraphData, 'entities' | 'facts' | 'sources'>) {
  const impact = analyzeImpact(data)
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const name = (id: string) => byId.get(id)?.name ?? id
  const guidance: string[] = []
  const guide = (detail: string) => { let index = guidance.indexOf(detail); if (index < 0) index = guidance.push(detail) - 1; return index }
  return {
    seeds: impact.seeds.map(s => ({ id: s.entity.id, name: s.entity.name, kind: s.entity.kind, ...(s.derived ? { derived: { via: name(s.derived.via), first_use: s.derived.at } } : compromiseOf(s.entity)) })),
    first: impact.first, last: impact.last, undated_evidence: impact.undated,
    steps: impact.steps.slice(0, 100).map(s => ({ operation: s.operation, effect: s.effect, by: s.seeds.map(name), with: s.others.slice(0, 5).map(name), with_total: s.others.length, targets: s.targets.length,
      sample_targets: s.targets.slice(0, 3).map(name), count: s.count, first: s.first, last: s.last })),
    steps_total: impact.steps.length,
    impacted: impact.impacted.slice(0, 100).map(i => ({ id: i.entity.id, name: i.entity.name, kind: i.entity.kind, effect: i.effect,
      operations: i.operations.slice(0, 3).map(o => `${o.operation} ×${o.count}`), last: i.last })),
    impacted_total: impact.impacted.length,
    pivots: impact.pivots.slice(0, 100).map(p => ({ id: p.entity.id, name: p.entity.name, kind: p.entity.kind, roles: p.roles, count: p.count,
      new_since_compromise: !p.before, seen_before: p.before, first: p.first, last: p.last })),
    rotate: impact.rotation.slice(0, 100).map(r => ({ entity_id: r.entityId, category: r.category, title: r.title, guidance: guide(r.detail), last_use: r.lastUse, rotated_at: r.rotatedAt, stale: r.stale })),
    rotate_total: impact.rotation.length,
    rotation_guidance: guidance,
    variables_read: { projects: impact.variables.slice(0, 200).map(v => v.path), inherited_from_groups: [...new Set(impact.variables.flatMap(v => v.groups))].sort(), total: impact.variables.length },
    hunting: huntingQueries(data, impact).map(q => ({ title: q.title, why: q.why, tables: q.tables, imported: q.imported, query: q.query })),
  }
}

/** Tables whose import name is not the Log Analytics table, and the columns that find the row there. */
const SOURCE_TABLES: Record<string, { table: string; keys?: string[] }> = {
  'Entra credential changes': { table: 'AuditLogs', keys: ['CorrelationId'] },
}

/**
 * KQL that returns the original row of one evidence item: the table from the import (or the rows' Type column for
 * custom tables such as GitLab), the key columns from its locator ("AzureActivity CorrelationId=… EventDataId=…") and
 * a ten-minute window around its time.
 */
export function evidenceQuery(item: { locator?: string; valid_from: string | null; source_id: string | null }, sources: Pick<GraphData['sources'][number], 'id' | 'title' | 'excerpt'>[]): string | null {
  const locator = item.locator ?? ''
  const first = locator.search(/\s\S+=/)
  const name = (first < 0 ? locator : locator.slice(0, first)).trim()
  const pairs = first < 0 ? [] : [...locator.slice(first).matchAll(/(\S+)=(\S+)/g)].map(m => [m[1], m[2]] as const)
  const source = sources.find(s => s.id === item.source_id)
  const custom = source && /"Type":\s*"([A-Za-z][\w]*)"/.exec(source.excerpt.slice(0, 4000))?.[1]
  const known = SOURCE_TABLES[name]
  const table = known?.table ?? (/^[A-Za-z][\w]*$/.test(name) ? name : custom)
  if (!table) return null
  const keys = pairs.filter(([key]) => !known?.keys || known.keys.includes(key)).filter(([key]) => /^[A-Za-z_][\w]*$/.test(key))
  const lines = [table]
  if (item.valid_from) lines.push(`| where TimeGenerated between (datetime(${item.valid_from}) - 10m .. datetime(${item.valid_from}) + 10m)`)
  if (keys.length) lines.push(`| where ${keys.map(([key, value]) => `${key} == ${literal(value)}`).join(' and ')}`)
  if (!item.valid_from && !keys.length) return null
  return lines.join('\n')
}
