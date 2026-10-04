"""Recognise Defender XDR and Microsoft Sentinel exports and map their columns to activities.

A CSV or JSON export of an advanced hunting or Log Analytics query is matched against the table schemas from the
Microsoft docs (app/data/table_schemas.json, built by scripts/build_table_schemas.py). For the common tables a curated
mapping says which columns are the actor, the device, the remote IP, the file … and which columns identify them
(DeviceId, AccountObjectId, SHA256 …), so the same device or user from different exports ends up on one entity.
Unknown tables get a mapping from column-name heuristics that the analyst confirms in the import dialog.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Callable

Row = dict

SCHEMAS = Path(__file__).parent / "data" / "table_schemas.json"


@lru_cache(maxsize=1)
def schemas() -> dict:
    try:
        return json.loads(SCHEMAS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"tables": {}, "asim": {}, "asim_common": {}}


# ---------------------------------------------------------------------------------------------- values

def clean_column(name: str) -> str:
    """Export headers carry decorations: a BOM, quotes, Log Analytics' " [UTC]" on datetime columns."""
    name = str(name).replace("﻿", "").strip().strip('"').strip()
    return re.sub(r"\s*\[(?:UTC|Local)\]$", "", name)


def clean_rows(rows: list[Row]) -> list[Row]:
    return [{clean_column(k): v for k, v in row.items()} for row in rows]


TIME_FORMATS = ("%m/%d/%Y, %I:%M:%S.%f %p", "%m/%d/%Y, %I:%M:%S %p", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M:%S",
                "%b %d, %Y %I:%M:%S %p", "%b %d, %Y %H:%M:%S", "%d.%m.%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S")


def parse_time(value) -> str | None:
    """ISO 8601 in UTC from the formats the portals export (Log Analytics uses "9/28/2026, 10:42:07.123 AM")."""
    text = str(value or "").strip()
    if not text:
        return None
    iso = re.sub(r"(\.\d{6})\d+", r"\1", text.replace("Z", "+00:00"))  # 7-digit fractions from .NET
    try:
        moment = datetime.fromisoformat(iso)
    except ValueError:
        moment = None
        for pattern in TIME_FORMATS:
            try:
                moment = datetime.strptime(text, pattern)
                break
            except ValueError:
                continue
        if moment is None:
            return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)  # exports are UTC unless they say otherwise
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def get(row: Row, path: str, cache: dict | None = None):
    """A column, or a value inside a JSON column: "DeviceDetail.displayName", "TargetResources.0.userPrincipalName"."""
    if path in row:
        return row[path]
    head, _, rest = path.partition(".")
    if not rest or head not in row:
        return None
    value = row[head]
    if isinstance(value, str):
        key = (id(row), head)
        if cache is not None and key in cache:
            value = cache[key]
        else:
            try:
                value = json.loads(value) if value.strip()[:1] in "[{" else None
            except ValueError:
                value = None
            if cache is not None:
                cache[key] = value
    for part in rest.split("."):
        if isinstance(value, list) and part.isdigit():
            value = value[int(part)] if int(part) < len(value) else None
        elif isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def text(value) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    out = str(value).strip()
    return "" if out.lower() in ("", "null", "none", "-", "n/a", "00000000-0000-0000-0000-000000000000") else out


def phrase(value: str) -> str:
    """ActionType "ConnectionSuccess" → "connection success"; already readable values stay."""
    value = text(value)
    if " " in value or not value:
        return value
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", value).lower()


# --------------------------------------------------------------------------------------------- mapping

@dataclass(frozen=True)
class Ident:
    field: str
    scheme: str = "external_id"
    namespace: str = ""


@dataclass(frozen=True)
class Part:
    """One participant: its role, entity type, the column(s) holding its name, and identifying columns."""
    role: str
    kind: str
    fields: tuple[str, ...]
    ids: tuple[Ident, ...] = ()
    lower: bool = False
    name: Callable[[Row, Callable], str] | None = None
    kind_of: Callable[[str], str] | None = None
    # Files and processes: the column with the full path or folder, and the device it is on. Without a hash, the
    # entity is identified by device and path, never by its file name alone.
    path: tuple[str, ...] = ()
    scope: tuple[str, ...] = ()


SCOPED_KINDS = ("File", "Process")
DEVICE_SCOPE = ("DeviceName", "Computer", "DvcHostname", "DstHostname", "TargetHostname", "SrcHostname", "DeviceId")


def full_path(folder: str, name: str) -> str:
    """MDE's FolderPath usually ends with the file name; otherwise the name is appended."""
    folder = folder.strip()
    if not folder or not name:
        return folder
    sep = "/" if "/" in folder and "\\" not in folder else "\\"
    return folder if folder.replace("/", "\\").lower().rstrip("\\").endswith("\\" + name.lower()) or folder.lower() == name.lower() \
        else folder.rstrip("\\/") + sep + name


@dataclass(frozen=True)
class Mapping:
    table: str
    product: str
    signature: tuple[str, ...]
    parts: tuple[Part, ...]
    operation: str | Callable[[Row, Callable], str] = "ActionType"
    time: tuple[str, ...] = ("Timestamp", "TimeGenerated")
    end: tuple[str, ...] = ()
    locator: tuple[str, ...] = ("ReportId", "DeviceId")


def url_kind(value: str) -> str:
    return "URL" if "://" in value or "/" in value.strip("/") else "Domain"


def resource_kind(value: str) -> str:
    v = value.lower()
    for needle, kind in (("/vaults/", "Key Vault"), ("/virtualmachines/", "Virtual Machine"), ("/storageaccounts/", "Storage Account"),
                         ("/managedclusters/", "AKS Cluster"), ("/sites/", "App Service"), ("/subscriptions/", "Azure Resource")):
        if needle in v:
            return kind
    return "Azure Resource"


def resource_name(row: Row, g: Callable, fields=("_ResourceId", "ResourceId", "Resource")) -> str:
    value = next((text(g(f)) for f in fields if text(g(f))), "")
    return value.rstrip("/").split("/")[-1] if "/" in value else value


def account(*upn: str, domain: str = "", name: str = "") -> Callable[[Row, Callable], str]:
    """UPN if present, else DOMAIN\\name."""
    def build(row: Row, g: Callable) -> str:
        for f in upn:
            if text(g(f)):
                return text(g(f)).lower()
        n = text(g(name)) if name else ""
        d = text(g(domain)) if domain else ""
        return f"{d}\\{n}" if d and n and "\\" not in n else n
    return build


def file_name(name_field: str, folder_field: str) -> Callable[[Row, Callable], str]:
    def build(row: Row, g: Callable) -> str:
        return text(g(name_field)) or text(g(folder_field)).replace("/", "\\").rstrip("\\").split("\\")[-1]
    return build


DEVICE_IDS = (Ident("DeviceId", namespace="mde-device-id"), Ident("AadDeviceId", namespace="entra-device-id"))
HASHES = lambda prefix="": (Ident(f"{prefix}SHA256", namespace="sha256"), Ident(f"{prefix}SHA1", namespace="sha1"), Ident(f"{prefix}MD5", namespace="md5"))  # noqa: E731


def device(role="source", fields=("DeviceName",), ids=DEVICE_IDS) -> Part:
    return Part(role, "Device", fields, ids + (Ident(fields[0], "fqdn"),), lower=True)


def initiating_account(role="actor") -> Part:
    return Part(role, "User", ("InitiatingProcessAccountUpn",), (Ident("InitiatingProcessAccountObjectId", namespace="entra-object-id"),
                Ident("InitiatingProcessAccountSid", namespace="windows-sid"), Ident("InitiatingProcessAccountUpn", "email")),
                name=account("InitiatingProcessAccountUpn", domain="InitiatingProcessAccountDomain", name="InitiatingProcessAccountName"))


def initiating_process(role="via") -> Part:
    return Part(role, "Process", ("InitiatingProcessFileName",), HASHES("InitiatingProcess"), path=("InitiatingProcessFolderPath",))


def sign_in(row: Row, g: Callable, result="ResultType", error="ErrorCode") -> str:
    code = text(g(result)) or text(g(error))
    return "signed in" if code in ("", "0") else f"sign-in failed ({code})"


MAPPINGS: tuple[Mapping, ...] = (
    # ---------------------------------------------------------------- Defender XDR (and the same tables in Sentinel)
    Mapping("DeviceProcessEvents", "Defender XDR", ("DeviceName", "FileName", "ProcessCommandLine", "InitiatingProcessFileName"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "Process", ("FileName",), HASHES(), path=("FolderPath",)),
        Part("identity", "User", ("AccountUpn",), (Ident("AccountObjectId", namespace="entra-object-id"), Ident("AccountSid", namespace="windows-sid"),
             Ident("AccountUpn", "email")), name=account("AccountUpn", domain="AccountDomain", name="AccountName")))),
    Mapping("DeviceNetworkEvents", "Defender XDR", ("DeviceName", "RemoteIP", "RemotePort", "InitiatingProcessFileName"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "IP", ("RemoteIP",), (Ident("RemoteIP", "ip"),)),
        Part("target", "Domain", ("RemoteUrl",), kind_of=url_kind))),
    Mapping("DeviceFileEvents", "Defender XDR", ("DeviceName", "FileName", "FolderPath", "InitiatingProcessFileName"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "File", ("FileName",), HASHES(), name=file_name("FileName", "FolderPath"), path=("FolderPath",)),
        Part("source", "Domain", ("FileOriginUrl",), kind_of=url_kind),
        Part("source", "IP", ("FileOriginIP", "RequestSourceIP"), (Ident("FileOriginIP", "ip"),)))),
    Mapping("DeviceLogonEvents", "Defender XDR", ("DeviceName", "LogonType", "AccountName"), (
        device("target"),
        Part("actor", "User", ("AccountName",), (Ident("AccountSid", namespace="windows-sid"),), name=account(domain="AccountDomain", name="AccountName")),
        Part("source", "IP", ("RemoteIP",), (Ident("RemoteIP", "ip"),)),
        Part("source", "Device", ("RemoteDeviceName",), (Ident("RemoteDeviceName", "fqdn"),), lower=True)),
        operation=lambda r, g: f"{phrase(g('ActionType'))} ({text(g('LogonType'))})" if text(g("LogonType")) else phrase(g("ActionType"))),
    Mapping("DeviceRegistryEvents", "Defender XDR", ("DeviceName", "RegistryKey", "InitiatingProcessFileName"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "Registry Key", ("RegistryKey",)))),
    Mapping("DeviceImageLoadEvents", "Defender XDR", ("DeviceName", "FileName", "FolderPath", "InitiatingProcessFileName", "InitiatingProcessId"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "File", ("FileName",), HASHES(), name=file_name("FileName", "FolderPath"), path=("FolderPath",)))),
    Mapping("DeviceEvents", "Defender XDR", ("DeviceName", "ActionType", "InitiatingProcessFileName", "RemoteUrl", "FileName"), (
        device(), initiating_account(), initiating_process(),
        Part("target", "File", ("FileName",), HASHES(), name=file_name("FileName", "FolderPath"), path=("FolderPath",)),
        Part("target", "IP", ("RemoteIP",), (Ident("RemoteIP", "ip"),)),
        Part("target", "Domain", ("RemoteUrl",), kind_of=url_kind),
        Part("target", "Registry Key", ("RegistryKey",)))),
    Mapping("IdentityLogonEvents", "Defender XDR", ("AccountUpn", "LogonType", "Protocol", "Application"), (
        Part("actor", "User", ("AccountUpn",), (Ident("AccountObjectId", namespace="entra-object-id"), Ident("AccountSid", namespace="windows-sid"),
             Ident("AccountUpn", "email")), name=account("AccountUpn", domain="AccountDomain", name="AccountName")),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        device("source", ("DeviceName",), ()),
        device("target", ("DestinationDeviceName", "TargetDeviceName"), ()),
        Part("target", "Service", ("Application",))),
        locator=("ReportId",)),
    Mapping("IdentityDirectoryEvents", "Defender XDR", ("AccountUpn", "TargetAccountUpn", "ActionType", "Application"), (
        Part("actor", "User", ("AccountUpn",), (Ident("AccountObjectId", namespace="entra-object-id"), Ident("AccountUpn", "email")),
             name=account("AccountUpn", domain="AccountDomain", name="AccountName")),
        Part("target", "User", ("TargetAccountUpn", "TargetAccountDisplayName"), (Ident("TargetAccountUpn", "email"),), lower=True),
        device("source", ("DeviceName",), ()),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        device("target", ("TargetDeviceName",), ())),
        locator=("ReportId",)),
    Mapping("IdentityQueryEvents", "Defender XDR", ("QueryType", "QueryTarget", "DestinationDeviceName"), (
        Part("actor", "User", ("AccountUpn",), (Ident("AccountObjectId", namespace="entra-object-id"),), name=account("AccountUpn", domain="AccountDomain", name="AccountName")),
        device("source", ("DeviceName",), ()),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        device("target", ("DestinationDeviceName",), ()),
        Part("target", "Other", ("QueryTarget",))),
        operation=lambda r, g: f"{phrase(g('ActionType'))} {text(g('QueryType'))}".strip(), locator=("ReportId",)),
    Mapping("EntraIdSignInEvents", "Defender XDR", ("AccountUpn", "Application", "ErrorCode", "LogonType"), (
        Part("actor", "User", ("AccountUpn",), (Ident("AccountObjectId", namespace="entra-object-id"), Ident("AccountUpn", "email")), lower=True),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("Application",), (Ident("ApplicationId", namespace="entra-app-id"),)),
        device("via", ("DeviceName",), (Ident("AadDeviceId", namespace="entra-device-id"),))),
        operation=lambda r, g: sign_in(r, g, "ErrorCode"), locator=("ReportId", "RequestId", "CorrelationId")),
    Mapping("EntraIdSpnSignInEvents", "Defender XDR", ("ServicePrincipalName", "ServicePrincipalId", "ErrorCode"), (
        Part("identity", "Service Principal", ("ServicePrincipalName",), (Ident("ServicePrincipalId", namespace="entra-object-id"),
             Ident("ApplicationId", namespace="entra-app-id"))),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("ResourceDisplayName", "Application"), (Ident("ResourceId", namespace="entra-app-id"),))),
        operation=lambda r, g: sign_in(r, g, "ErrorCode"), locator=("ReportId", "RequestId", "CorrelationId")),
    Mapping("CloudAppEvents", "Defender XDR", ("Application", "ActionType", "AccountObjectId", "ObjectName"), (
        Part("actor", "User", ("AccountDisplayName", "AccountId"), (Ident("AccountObjectId", namespace="entra-object-id"),)),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("Application",), (Ident("ApplicationId", namespace="mdca-app-id"),)),
        Part("target", "Other", ("ObjectName",))),
        locator=("ReportId",)),
    Mapping("UrlClickEvents", "Defender XDR", ("Url", "ActionType", "AccountUpn", "NetworkMessageId"), (
        Part("actor", "User", ("AccountUpn",), (Ident("AccountUpn", "email"),), lower=True),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "URL", ("Url",), kind_of=url_kind)),
        locator=("ReportId", "NetworkMessageId")),
    Mapping("EmailEvents", "Defender XDR", ("SenderFromAddress", "RecipientEmailAddress", "NetworkMessageId", "Subject"), (
        Part("actor", "Email Address", ("SenderFromAddress",), (Ident("SenderFromAddress", "email"),), lower=True),
        Part("target", "Email Address", ("RecipientEmailAddress",), (Ident("RecipientEmailAddress", "email"),), lower=True),
        Part("source", "IP", ("SenderIPv4", "SenderIPv6"), (Ident("SenderIPv4", "ip"),))),
        operation=lambda r, g: f"sent email ({text(g('DeliveryAction')).lower()})" if text(g("DeliveryAction")) else "sent email",
        locator=("NetworkMessageId", "ReportId")),
    Mapping("EmailUrlInfo", "Defender XDR", ("NetworkMessageId", "Url", "UrlDomain", "UrlLocation"), (
        Part("source", "Email Message", ("NetworkMessageId",)),
        Part("target", "URL", ("Url",), kind_of=url_kind)),
        operation="contains URL", locator=("NetworkMessageId", "ReportId")),
    Mapping("EmailAttachmentInfo", "Defender XDR", ("NetworkMessageId", "FileName", "SHA256", "SenderFromAddress"), (
        Part("actor", "Email Address", ("SenderFromAddress",), (Ident("SenderFromAddress", "email"),), lower=True),
        Part("target", "Email Address", ("RecipientEmailAddress",), (Ident("RecipientEmailAddress", "email"),), lower=True),
        Part("tool", "File", ("FileName",), (Ident("SHA256", namespace="sha256"),))),
        operation="sent attachment", locator=("NetworkMessageId", "ReportId")),
    Mapping("AlertEvidence", "Defender XDR", ("AlertId", "EntityType", "EvidenceRole", "Title"), (
        Part("other", "Alert", ("Title",), (Ident("AlertId", namespace="defender-alert-id"),)),
        Part("target", "Device", ("DeviceName",), (Ident("DeviceId", namespace="mde-device-id"),), lower=True),
        Part("target", "User", ("AccountUpn", "AccountName"), (Ident("AccountObjectId", namespace="entra-object-id"), Ident("AccountUpn", "email")), lower=True),
        Part("target", "IP", ("RemoteIP",), (Ident("RemoteIP", "ip"),)),
        Part("target", "Domain", ("RemoteUrl",), kind_of=url_kind),
        Part("target", "File", ("FileName",), HASHES(), path=("FolderPath",)),
        Part("target", "Email Address", ("EmailSubject",))),
        operation=lambda r, g: f"alert evidence ({text(g('EvidenceRole')).lower() or 'related'})", locator=("AlertId", "ReportId")),

    # -------------------------------------------------------------------------------------------- Sentinel
    Mapping("SigninLogs", "Sentinel", ("UserPrincipalName", "AppDisplayName", "ResultType", "IPAddress", "ConditionalAccessStatus"), (
        Part("actor", "User", ("UserPrincipalName",), (Ident("UserId", namespace="entra-object-id"), Ident("UserPrincipalName", "email")), lower=True),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("AppDisplayName",), (Ident("AppId", namespace="entra-app-id"),)),
        Part("via", "Device", ("DeviceDetail.displayName",), (Ident("DeviceDetail.deviceId", namespace="entra-device-id"),), lower=True)),
        operation=sign_in, time=("TimeGenerated", "CreatedDateTime"), locator=("CorrelationId", "Id")),
    Mapping("AADNonInteractiveUserSignInLogs", "Sentinel", ("UserPrincipalName", "AppDisplayName", "ResultType", "IPAddress", "IsInteractive"), (
        Part("actor", "User", ("UserPrincipalName",), (Ident("UserId", namespace="entra-object-id"), Ident("UserPrincipalName", "email")), lower=True),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("AppDisplayName",), (Ident("AppId", namespace="entra-app-id"),)),
        Part("via", "Device", ("DeviceDetail.displayName",), (Ident("DeviceDetail.deviceId", namespace="entra-device-id"),), lower=True)),
        operation=lambda r, g: sign_in(r, g).replace("signed in", "signed in (non-interactive)"), time=("TimeGenerated", "CreatedDateTime"), locator=("CorrelationId", "Id")),
    Mapping("AADServicePrincipalSignInLogs", "Sentinel", ("ServicePrincipalName", "ServicePrincipalId", "ResourceDisplayName", "ResultType"), (
        Part("identity", "Service Principal", ("ServicePrincipalName",), (Ident("ServicePrincipalId", namespace="entra-object-id"), Ident("AppId", namespace="entra-app-id"))),
        Part("source", "IP", ("IPAddress",), (Ident("IPAddress", "ip"),)),
        Part("target", "Service", ("ResourceDisplayName",), (Ident("ResourceIdentity", namespace="entra-app-id"),))),
        operation=sign_in, locator=("CorrelationId", "Id")),
    Mapping("AuditLogs", "Sentinel", ("OperationName", "InitiatedBy", "TargetResources", "Category"), (
        Part("actor", "User", ("InitiatedBy.user.userPrincipalName",), (Ident("InitiatedBy.user.id", namespace="entra-object-id"),
             Ident("InitiatedBy.user.userPrincipalName", "email")), lower=True),
        Part("identity", "Service Principal", ("InitiatedBy.app.displayName",), (Ident("InitiatedBy.app.servicePrincipalId", namespace="entra-object-id"),)),
        Part("source", "IP", ("InitiatedBy.user.ipAddress",), (Ident("InitiatedBy.user.ipAddress", "ip"),)),
        Part("target", "User", ("TargetResources.0.userPrincipalName", "TargetResources.0.displayName"), (Ident("TargetResources.0.id", namespace="entra-object-id"),))),
        operation=lambda r, g: text(g("OperationName")), time=("TimeGenerated", "ActivityDateTime"), locator=("CorrelationId", "Id")),
    Mapping("AzureActivity", "Sentinel", ("Caller", "OperationNameValue", "ResourceGroup", "CallerIpAddress"), (
        Part("actor", "User", ("Caller",), (Ident("Caller", "email"),), lower=True,
             kind_of=lambda v: "User" if "@" in v else "Service Principal"),
        Part("source", "IP", ("CallerIpAddress",), (Ident("CallerIpAddress", "ip"),)),
        Part("target", "Azure Resource", ("_ResourceId",), (Ident("_ResourceId", "resource_id"), Ident("ResourceId", "resource_id")),
             name=resource_name, kind_of=resource_kind)),
        operation=lambda r, g: text(g("OperationName")) or text(g("OperationNameValue")), locator=("CorrelationId", "EventDataId")),
    Mapping("AzureDiagnostics (Key Vault)", "Sentinel", ("OperationName", "CallerIPAddress", "ResourceProvider", "identity_claim_appid_g"), (
        Part("actor", "User", ("identity_claim_http_schemas_xmlsoap_org_ws_2005_05_identity_claims_upn_s", "identity_claim_upn_s"),
             (Ident("identity_claim_http_schemas_microsoft_com_identity_claims_objectidentifier_g", namespace="entra-object-id"),), lower=True),
        Part("identity", "Service Principal", ("identity_claim_appid_g",), (Ident("identity_claim_appid_g", namespace="entra-app-id"),)),
        Part("source", "IP", ("CallerIPAddress",), (Ident("CallerIPAddress", "ip"),)),
        Part("target", "Key Vault", ("Resource",), (Ident("ResourceId", "resource_id"),), lower=True)),
        operation=lambda r, g: text(g("OperationName")), locator=("CorrelationId", "requestUri_s")),
    Mapping("SecurityEvent", "Sentinel", ("EventID", "Computer", "Activity", "Account"), (
        Part("actor", "User", ("TargetAccount", "Account"), (Ident("TargetUserSid", namespace="windows-sid"),),
             name=lambda r, g: text(g("TargetAccount")) if text(g("EventID")) in ("4624", "4625") and text(g("TargetAccount")) else text(g("Account"))),
        device("target", ("Computer",), ()),
        Part("source", "IP", ("IpAddress",), (Ident("IpAddress", "ip"),)),
        device("source", ("WorkstationName",), ()),
        Part("via", "Process", ("NewProcessName", "Process"), name=lambda r, g: (text(g("NewProcessName")) or text(g("Process"))).replace("/", "\\").split("\\")[-1],
             path=("NewProcessName",), scope=("Computer",))),
        operation=lambda r, g: text(g("Activity")), locator=("EventRecordId", "EventOriginId")),
    Mapping("CommonSecurityLog", "Sentinel", ("DeviceVendor", "DeviceProduct", "SourceIP", "DestinationIP"), (
        Part("actor", "User", ("SourceUserName",), lower=True),
        Part("source", "IP", ("SourceIP",), (Ident("SourceIP", "ip"),)),
        Part("target", "IP", ("DestinationIP",), (Ident("DestinationIP", "ip"),)),
        Part("target", "Domain", ("DestinationHostName", "RequestURL"), kind_of=url_kind),
        Part("via", "System", ("DeviceProduct",),
             name=lambda r, g: " ".join(v for v in (text(g("DeviceVendor")), text(g("DeviceProduct"))) if v))),
        operation=lambda r, g: text(g("DeviceAction")) or text(g("Activity")) or "connection", locator=("DeviceEventClassID", "ExtID")),
    Mapping("OfficeActivity", "Sentinel", ("Operation", "UserId", "OfficeWorkload", "ClientIP"), (
        Part("actor", "User", ("UserId",), (Ident("UserId", "email"),), lower=True),
        Part("source", "IP", ("ClientIP", "Client_IPAddress"), (Ident("ClientIP", "ip"),),
             name=lambda r, g: re.sub(r"^\[?([^\]]+?)\]?(?::\d+)?$", r"\1", text(g("ClientIP")) or text(g("Client_IPAddress")))),
        Part("target", "Other", ("OfficeObjectId", "ObjectId", "Site_Url"))),
        operation=lambda r, g: text(g("Operation")), locator=("OfficeId", "Id")),
)

# ASIM (normalised Sentinel parsers, e.g. _Im_Authentication): the same fields for every source.
ASIM = Mapping("ASIM", "Sentinel ASIM", ("EventType", "EventSchema"), (
    Part("actor", "User", ("ActorUsername",), (Ident("ActorUserId", namespace="asim-user-id"),), lower=True),
    Part("source", "IP", ("SrcIpAddr",), (Ident("SrcIpAddr", "ip"),)),
    Part("source", "Device", ("SrcHostname", "SrcDvcHostname"), (Ident("SrcDvcId", namespace="asim-device-id"),), lower=True),
    Part("target", "User", ("TargetUsername",), (Ident("TargetUserId", namespace="asim-user-id"),), lower=True),
    Part("target", "IP", ("DstIpAddr",), (Ident("DstIpAddr", "ip"),)),
    Part("target", "Device", ("DstHostname", "TargetHostname", "DvcHostname"), (Ident("DstDvcId", namespace="asim-device-id"),), lower=True),
    Part("target", "Service", ("TargetAppName",), (Ident("TargetAppId", namespace="asim-app-id"),)),
    Part("target", "Domain", ("Url", "DnsQuery"), kind_of=url_kind),
    Part("target", "Process", ("TargetProcessName",), (Ident("TargetProcessSHA256", namespace="sha256"),), path=("TargetProcessName",),
         name=lambda r, g: text(g("TargetProcessName")).replace("/", "\\").split("\\")[-1]),
    Part("target", "File", ("TargetFileName", "TargetFilePath"), (Ident("TargetFileSHA256", namespace="sha256"),), path=("TargetFilePath",)),
    Part("via", "Process", ("ActingProcessName",), name=lambda r, g: text(g("ActingProcessName")).replace("/", "\\").split("\\")[-1], path=("ActingProcessName",))),
    operation=lambda r, g: " ".join(v for v in (phrase(g("EventType")), f"({text(g('EventResult')).lower()})" if text(g("EventResult")) else "") if v),
    time=("TimeGenerated", "EventStartTime"), end=("EventEndTime",), locator=("EventUid", "EventOriginalUid"))

# --------------------------------------------------------------------------------------------- heuristic

HEURISTIC: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    # role, kind, candidate columns (first present wins), identifier scheme/namespace
    ("actor", "User", ("AccountUpn", "UserPrincipalName", "InitiatingProcessAccountUpn", "ActorUsername", "Caller", "UserId", "SourceUserName",
                       "SubjectUserName", "AccountName", "User", "Username", "user"), "email"),
    ("source", "IP", ("IPAddress", "ClientIP", "CallerIpAddress", "CallerIPAddress", "SourceIP", "SrcIpAddr", "IpAddress", "LocalIP", "SenderIPv4",
                      "src_ip", "source_ip", "ClientIPAddress"), "ip"),
    ("source", "Device", ("DeviceName", "Computer", "HostName", "Hostname", "SrcHostname", "WorkstationName", "host"), "fqdn"),
    ("target", "IP", ("RemoteIP", "DestinationIP", "DstIpAddr", "dest_ip", "destination_ip"), "ip"),
    ("target", "Device", ("TargetDeviceName", "DestinationDeviceName", "DstHostname", "RemoteDeviceName"), "fqdn"),
    ("target", "URL", ("RemoteUrl", "Url", "URL", "RequestURL", "TargetUrl", "FileOriginUrl"), ""),
    ("target", "Azure Resource", ("_ResourceId", "ResourceId", "TargetResource"), "resource_id"),
    ("target", "Service", ("Application", "AppDisplayName", "TargetAppName", "ResourceDisplayName"), ""),
    ("target", "File", ("FileName", "TargetFileName", "FilePath", "FolderPath"), ""),
)
OPERATION_FIELDS = ("ActionType", "OperationName", "Operation", "OperationNameValue", "Activity", "EventType", "QueryType", "DeviceAction", "action")
TIME_FIELDS = ("Timestamp", "TimeGenerated", "CreatedDateTime", "EventStartTime", "TimeCreated", "StartTime", "timestamp", "time", "event_time")
LOCATOR_FIELDS = ("ReportId", "CorrelationId", "EventRecordId", "EventId", "EventID", "RecordId", "Id", "id", "NetworkMessageId", "AlertId", "RequestId")


def heuristic(columns: set[str], table: str = "", product: str = "") -> Mapping | None:
    parts = []
    used: set[str] = set()
    for role, kind, candidates, scheme in HEURISTIC:
        column = next((c for c in candidates if c in columns and c not in used), None)
        if not column:
            continue
        used.add(column)
        ids = (Ident(column, scheme),) if scheme in ("ip", "email", "fqdn", "resource_id") else ()
        if kind == "File":
            ids += tuple(Ident(h, namespace=h.lower()) for h in ("SHA256", "SHA1", "MD5") if h in columns)
        parts.append(Part(role, kind, (column,), ids, lower=kind in ("User", "Device"),
                          path=tuple(c for c in ("FolderPath", "FilePath", "TargetFilePath") if c in columns) if kind == "File" else (),
                          kind_of=url_kind if kind == "URL" else resource_kind if kind == "Azure Resource" else None,
                          name=resource_name if kind == "Azure Resource" else None))
    if len(parts) < 2:
        return None
    operation = next((c for c in OPERATION_FIELDS if c in columns), None)
    return Mapping(table or "Unknown table", product or "", (), tuple(parts),
                   operation=(lambda r, g, c=operation: phrase(g(c)) or "observed") if operation else "observed",
                   time=tuple(c for c in TIME_FIELDS if c in columns), locator=tuple(c for c in LOCATOR_FIELDS if c in columns)[:2])


# --------------------------------------------------------------------------------------------- detection

@dataclass
class Detection:
    table: str
    product: str
    mapping: Mapping | None
    confident: bool
    known_columns: int
    total_columns: int
    doc: str = ""
    candidates: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        return {"table": self.table, "product": self.product, "confident": self.confident, "known_columns": self.known_columns,
                "total_columns": self.total_columns, "doc": self.doc, "candidates": self.candidates,
                "roles": [{"field": p.fields[0], "role": p.role, "kind": p.kind,
                           "identifiers": [i.field for i in p.ids if i.field != p.fields[0]]} for p in (self.mapping.parts if self.mapping else ())],
                "operation": self.mapping.operation if self.mapping and isinstance(self.mapping.operation, str) else
                             ("derived from the row" if self.mapping else None)}


def detect(columns: set[str]) -> Detection:
    """Which table an export comes from. Curated mappings win; then the documented schemas; then column heuristics."""
    data = schemas()
    tables = data.get("tables", {})
    scored = []
    for name, info in tables.items():
        cols = set(info["columns"])
        hits = len(columns & cols)
        if hits >= 3:
            scored.append((hits / max(len(columns), 1) + hits / max(len(cols), 1) * 0.25, hits, name))
    scored.sort(reverse=True)
    best_schema = scored[0] if scored else None
    candidates = [name for _, _, name in scored[:3]]

    curated = [m for m in MAPPINGS if set(m.signature) <= columns]
    if curated:
        # Several curated mappings can match (DeviceEvents is broad): prefer the one whose documented schema fits best.
        def fit(m: Mapping) -> tuple[float, int]:
            cols = set(tables.get(m.table, {}).get("columns", {})) or set(m.signature)
            return (len(columns & cols) / max(len(columns), 1), len(m.signature))
        mapping = max(curated, key=fit)
        cols = set(tables.get(mapping.table, {}).get("columns", {}))
        known = len(columns & cols) if cols else len(set(mapping.signature))
        return Detection(mapping.table, mapping.product, mapping, True, known, len(columns), tables.get(mapping.table, {}).get("doc", ""), candidates)

    if {"EventType", "EventSchema"} <= columns or ("EventType" in columns and any(c in columns for c in ("SrcIpAddr", "DstIpAddr", "TargetUsername", "ActorUsername"))):
        asim = data.get("asim", {})
        schema = max(asim.items(), key=lambda kv: len(columns & set(kv[1]["columns"])), default=(None, None))
        cols = set(data.get("asim_common", {})) | (set(schema[1]["columns"]) if schema[1] else set())
        name = f"ASIM {schema[0]}" if schema[0] else "ASIM"
        return Detection(name, "Sentinel ASIM", ASIM, True, len(columns & cols), len(columns), schema[1]["doc"] if schema[1] else "", candidates)

    if best_schema and best_schema[0] >= 0.6 and best_schema[1] >= 5:
        name = best_schema[2]
        mapping = heuristic(columns, name, "Defender XDR")
        return Detection(name, "Defender XDR", mapping, mapping is not None, best_schema[1], len(columns), tables[name].get("doc", ""), candidates)

    mapping = heuristic(columns)
    return Detection("Unknown table", "", mapping, False, 0, len(columns), "", candidates)


# ---------------------------------------------------------------------------------------------- per row

def participants_of(mapping: Mapping, row: Row) -> list[dict]:
    """Entities of one row: role, kind, name and identifiers ({scheme, namespace, raw})."""
    cache: dict = {}
    g = lambda path: get(row, path, cache)  # noqa: E731
    out = []
    for part in mapping.parts:
        raw = next((text(g(f)) for f in part.fields if text(g(f))), "")
        name = text(part.name(row, g)) if part.name else raw
        if not name:
            continue
        if part.lower:
            name = name.lower()
        # The type comes from the full original value (a resource ID says Key Vault; its last segment does not).
        kind = part.kind_of(raw or name) if part.kind_of else part.kind
        identifiers = []
        scoped = kind in SCOPED_KINDS
        for ident in part.ids:
            raw = text(g(ident.field))
            if not raw:
                continue
            if ident.scheme == "fqdn" and "." not in raw:
                identifiers.append({"scheme": "hostname", "namespace": "", "raw": raw})
                continue
            identifiers.append({"scheme": ident.scheme, "namespace": ident.namespace, "raw": raw})
        if scoped:
            device = next((text(g(c)).lower() for c in (part.scope or DEVICE_SCOPE) if text(g(c))), "")
            path = full_path(next((text(g(c)) for c in part.path if text(g(c))), ""), name)
            if device and path:
                identifiers.append({"scheme": "external_id", "namespace": "device-path", "raw": f"{device}|{path}"})
            elif device:
                identifiers.append({"scheme": "external_id", "namespace": "device-file", "raw": f"{device}|{name}"})
        out.append({"role": part.role, "kind": kind, "name": name, "identifiers": identifiers, "by_name": not scoped})
    return out


def operation_of(mapping: Mapping, row: Row) -> str:
    cache: dict = {}
    g = lambda path: get(row, path, cache)  # noqa: E731
    if callable(mapping.operation):
        return text(mapping.operation(row, g)) or "observed"
    # A constant phrase ("contains URL") has spaces; a single word is a column name ("ActionType").
    if " " in mapping.operation:
        return mapping.operation
    return phrase(g(mapping.operation)) or "observed"


def time_of(mapping: Mapping, row: Row) -> tuple[str | None, str | None]:
    start = next((parse_time(row[f]) for f in mapping.time if text(row.get(f))), None)
    end = next((parse_time(row[f]) for f in mapping.end if text(row.get(f))), None)
    return start, end


def locator_of(mapping: Mapping, row: Row, row_number: int) -> str:
    parts = [f"{f}={text(row.get(f))}" for f in mapping.locator if text(row.get(f))]
    return f"{mapping.table} " + (" ".join(parts) if parts else f"row {row_number}")
