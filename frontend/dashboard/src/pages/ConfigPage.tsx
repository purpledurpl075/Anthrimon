import React, { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fetchPolicies, createPolicy, updatePolicy, deletePolicy, runPolicy,
  fetchComplianceResults, deployConfigMulti, previewDeployTargets,
  fetchGoldenConfigs, createGoldenConfig, updateGoldenConfig, deleteGoldenConfig,
  runGoldenConfig, fetchGoldenConfigResults, fetchBackups, fetchBackup,
  fetchGitStatus, setGitRemote, removeGitRemote, pushGitArchive,
  type CompliancePolicy, type ComplianceRule, type MultiDeployDeviceResult,
  type GoldenConfig, type GoldenConfigResult,
} from '../api/config'
import { fetchDevices } from '../api/devices'
import { useRole, hasRole } from '../hooks/useCurrentUser'
import { DEVICE_TYPE_COLOR, DeviceTypeIcon } from '../components/DeviceTypeIcon'
import { formatAge } from '../utils/time'

// ── Vendor-aware snippets ─────────────────────────────────────────────────────

const VENDOR_SNIPPETS: Record<string, { label: string; text: string }[]> = {
  arista: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging host {{syslog_server}}' },
    { label: 'SSH timeout',     text: 'management ssh\n   idle-timeout 120' },
    { label: 'Banner',          text: 'banner login\nAuthorized access only.\nEOF' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} ro' },
    { label: 'DNS',             text: 'ip name-server {{dns_server}}' },
    { label: 'Domain name',     text: 'ip domain-name {{domain}}' },
  ],
  cisco_ios: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging host {{syslog_server}}' },
    { label: 'SSH v2',          text: 'ip ssh version 2' },
    { label: 'Banner',          text: 'banner login #\nAuthorized access only.\n#' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} RO' },
    { label: 'DNS',             text: 'ip name-server {{dns_server}}' },
    { label: 'Domain name',     text: 'ip domain-name {{domain}}' },
    { label: 'Disable CDP',     text: 'no cdp run' },
  ],
  procurve: [
    { label: 'NTP server',      text: 'timesync ntp\nntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'logging {{syslog_server}}' },
    { label: 'Banner',          text: 'banner motd "Authorized access only"' },
    { label: 'SNMP community',  text: 'snmp-server community "{{community}}" operator' },
    { label: 'DNS',             text: 'ip dns server-address priority 1 {{dns_server}}' },
    { label: 'Timezone',        text: 'time timezone -300' },
  ],
  juniper: [
    { label: 'NTP server',      text: 'set system ntp server {{ntp_server}}' },
    { label: 'Syslog',          text: 'set system syslog host {{syslog_server}} any any' },
    { label: 'SSH',             text: 'set system services ssh' },
    { label: 'Banner',          text: 'set system login message "Authorized access only"' },
    { label: 'SNMP community',  text: 'set snmp community {{community}} authorization read-only' },
    { label: 'DNS',             text: 'set system name-server {{dns_server}}' },
  ],
  fortios: [
    { label: 'NTP server',      text: 'config system ntp\n  set ntpserver1 {{ntp_server}}\n  set status enable\nend' },
    { label: 'Syslog',          text: 'config log syslogd setting\n  set status enable\n  set server {{syslog_server}}\nend' },
    { label: 'DNS',             text: 'config system dns\n  set primary {{dns_server}}\nend' },
  ],
  generic: [
    { label: 'NTP server',      text: 'ntp server {{ntp_server}}' },
    { label: 'Syslog server',   text: 'logging host {{syslog_server}}' },
    { label: 'Interface desc',  text: 'interface {{interface}}\n  description {{description}}' },
    { label: 'Disable iface',   text: 'interface {{interface}}\n  shutdown' },
    { label: 'SNMP community',  text: 'snmp-server community {{community}} ro' },
  ],
}

function getSnippets(vendors: string[]) {
  if (vendors.length === 1) {
    const v = vendors[0].toLowerCase()
    for (const [key, snips] of Object.entries(VENDOR_SNIPPETS)) {
      if (v.includes(key) || key.includes(v)) return snips
    }
  }
  return VENDOR_SNIPPETS.generic
}

// ── Compliance rule templates ─────────────────────────────────────────────────

interface RuleTemplate {
  label: string
  category: string
  rule: ComplianceRule
  example?: string
}

const TEMPLATE_VENDORS: { key: string; label: string }[] = [
  { key: 'all',          label: 'All platforms' },
  { key: 'cisco_ios',    label: 'IOS / IOS-XE'  },
  { key: 'cisco_xr',     label: 'IOS-XR'         },
  { key: 'arista_eos',   label: 'Arista EOS'     },
  { key: 'aruba_cx',     label: 'Aruba CX'       },
  { key: 'aruba_switch', label: 'Aruba Switch'   },
  { key: 'junos',        label: 'JunOS'          },
]

const COMPLIANCE_TEMPLATES: Record<string, RuleTemplate[]> = {
  all: [
    { label: 'NTP server',       category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp server',                  description: 'NTP server must be configured' },              example: 'ntp server 10.0.0.1' },
    { label: 'Syslog server',    category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging (host|server|\\d+\\.)', description: 'Remote syslog must be configured' },          example: 'logging host 10.0.0.5' },
    { label: 'Login banner',     category: 'Security',   rule: { type: 'regex_present', pattern: 'banner (login|motd)',          description: 'Login banner must be configured' } },
    { label: 'SNMP configured',  category: 'Monitoring', rule: { type: 'regex_present', pattern: 'snmp-server',                 description: 'SNMP must be configured' } },
    { label: 'RADIUS server',    category: 'Auth',       rule: { type: 'regex_present', pattern: 'radius-server host',          description: 'RADIUS authentication server must be configured' } },
    { label: 'Spanning tree',    category: 'Protocols',  rule: { type: 'regex_present', pattern: 'spanning-tree mode',          description: 'STP mode must be explicitly set' } },
  ],
  cisco_ios: [
    { label: 'SSH v2 only',          category: 'Security',   rule: { type: 'contains',     pattern: 'ip ssh version 2',                  description: 'SSH version 2 must be enforced' },                  example: 'ip ssh version 2' },
    { label: 'No telnet on VTY',     category: 'Security',   rule: { type: 'regex_absent', pattern: 'transport input telnet',             description: 'Telnet must not be allowed on VTY lines' } },
    { label: 'Password encryption',  category: 'Security',   rule: { type: 'contains',     pattern: 'service password-encryption',        description: 'Service password-encryption must be enabled' },     example: 'service password-encryption' },
    { label: 'No HTTP server',       category: 'Security',   rule: { type: 'regex_absent', pattern: '^ip http server$',                   description: 'HTTP management server must be disabled' } },
    { label: 'Login banner',         category: 'Security',   rule: { type: 'regex_present', pattern: 'banner (login|exec|motd)',           description: 'Login banner must be set' } },
    { label: 'No SNMP v2c write',    category: 'Monitoring', rule: { type: 'regex_absent', pattern: 'snmp-server community \\S+ RW',      description: 'SNMP read-write community must not be configured' } },
    { label: 'AAA new-model',        category: 'Auth',       rule: { type: 'contains',     pattern: 'aaa new-model',                      description: 'AAA new-model must be enabled' },                   example: 'aaa new-model' },
    { label: 'TACACS+ server',       category: 'Auth',       rule: { type: 'regex_present', pattern: 'tacacs-server host|tacacs server',  description: 'TACACS+ server must be configured' } },
    { label: 'NTP configured',       category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp server \\S+',                   description: 'NTP server must be configured' },                   example: 'ntp server 10.0.0.1' },
    { label: 'Syslog host',          category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging \\d+\\.\\d+\\.\\d+\\.\\d+', description: 'Remote syslog host must be configured' },          example: 'logging 10.0.0.5' },
    { label: 'CDP disabled',         category: 'Protocols',  rule: { type: 'contains',     pattern: 'no cdp run',                         description: 'CDP must be disabled globally' },                   example: 'no cdp run' },
    { label: 'STP mode set',         category: 'Protocols',  rule: { type: 'regex_present', pattern: 'spanning-tree mode',                description: 'STP mode must be explicitly configured' },          example: 'spanning-tree mode rapid-pvst' },
    { label: 'Domain name set',      category: 'Identity',   rule: { type: 'regex_present', pattern: 'ip domain.name \\S+',               description: 'IP domain name must be configured' },               example: 'ip domain-name corp.example.com' },
  ],
  cisco_xr: [
    { label: 'SSH v2 only',      category: 'Security',   rule: { type: 'contains',      pattern: 'ssh server v2',                       description: 'SSH v2 must be enforced' },                            example: 'ssh server v2' },
    { label: 'No telnet',        category: 'Security',   rule: { type: 'regex_absent',  pattern: 'service telnet',                      description: 'Telnet service must be disabled' } },
    { label: 'No HTTP mgmt',     category: 'Security',   rule: { type: 'regex_absent',  pattern: 'http server',                         description: 'HTTP management must be disabled' } },
    { label: 'Login banner',     category: 'Security',   rule: { type: 'regex_present', pattern: 'banner (login|motd)',                  description: 'Login banner must be configured' } },
    { label: 'NTP server',       category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp\\s+server\\s+\\S+',               description: 'NTP server must be configured' },                      example: 'ntp server 10.0.0.1' },
    { label: 'Syslog host',      category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging \\S+ (vrf|port)',             description: 'Remote syslog host must be configured' },              example: 'logging 10.0.0.5 vrf default severity info' },
    { label: 'AAA configured',   category: 'Auth',       rule: { type: 'regex_present', pattern: 'aaa (authentication|authorization)',  description: 'AAA authentication/authorization must be configured' } },
    { label: 'TACACS+ server',   category: 'Auth',       rule: { type: 'regex_present', pattern: 'tacacs-server host|tacacs server',   description: 'TACACS+ server must be configured' } },
    { label: 'Domain name',      category: 'Identity',   rule: { type: 'regex_present', pattern: 'domain name \\S+',                   description: 'Domain name must be set' },                            example: 'domain name corp.example.com' },
  ],
  arista_eos: [
    { label: 'SSH management',       category: 'Security',   rule: { type: 'regex_present', pattern: 'management ssh',                    description: 'SSH management must be configured' },                  example: 'management ssh\n   idle-timeout 120' },
    { label: 'No telnet mgmt',       category: 'Security',   rule: { type: 'regex_absent',  pattern: 'management telnet',                 description: 'Telnet management must not be configured' } },
    { label: 'Login banner',         category: 'Security',   rule: { type: 'regex_present', pattern: 'banner login',                      description: 'Login banner must be set' } },
    { label: 'No SNMP v2c write',    category: 'Monitoring', rule: { type: 'regex_absent',  pattern: 'snmp-server community \\S+ rw',     description: 'SNMP read-write community must not be configured' } },
    { label: 'AAA authentication',   category: 'Auth',       rule: { type: 'regex_present', pattern: 'aaa authentication',                description: 'AAA authentication must be configured' } },
    { label: 'RADIUS server',        category: 'Auth',       rule: { type: 'regex_present', pattern: 'radius-server host|radius server', description: 'RADIUS server must be configured' } },
    { label: 'NTP server',           category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp server \\S+',                  description: 'NTP server must be configured' },                      example: 'ntp server 10.0.0.1' },
    { label: 'Syslog host',          category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging host \\S+',                description: 'Remote syslog host must be configured' },              example: 'logging host 10.0.0.5' },
    { label: 'STP mode set',         category: 'Protocols',  rule: { type: 'regex_present', pattern: 'spanning-tree mode',               description: 'STP mode must be configured' },                        example: 'spanning-tree mode mstp' },
    { label: 'Domain name',          category: 'Identity',   rule: { type: 'regex_present', pattern: 'ip domain-name \\S+',              description: 'IP domain name must be set' } },
  ],
  aruba_cx: [
    { label: 'SSH server',           category: 'Security',   rule: { type: 'regex_present', pattern: 'ssh server vrf',                   description: 'SSH server must be enabled on management VRF' },       example: 'ssh server vrf mgmt' },
    { label: 'No telnet',            category: 'Security',   rule: { type: 'regex_absent',  pattern: 'telnet server',                    description: 'Telnet server must not be enabled' } },
    { label: 'HTTPS only',           category: 'Security',   rule: { type: 'regex_absent',  pattern: 'web-ui http$',                     description: 'HTTP web UI must be disabled (use HTTPS)' } },
    { label: 'Login banner',         category: 'Security',   rule: { type: 'regex_present', pattern: 'banner motd',                      description: 'MOTD banner must be configured' } },
    { label: 'RADIUS server',        category: 'Auth',       rule: { type: 'regex_present', pattern: 'radius-server host',               description: 'RADIUS server must be configured' } },
    { label: 'Password complexity',  category: 'Auth',       rule: { type: 'regex_present', pattern: 'password (complexity|minimum-length)', description: 'Password complexity policy must be set' } },
    { label: 'NTP server',           category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp server \\S+',                  description: 'NTP server must be configured' },                      example: 'ntp server 10.0.0.1 prefer' },
    { label: 'Syslog remote',        category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging \\S+ vrf',                 description: 'Remote syslog must be configured' },                   example: 'logging 10.0.0.5 vrf mgmt' },
    { label: 'SNMP configured',      category: 'Monitoring', rule: { type: 'regex_present', pattern: 'snmp-server',                      description: 'SNMP must be configured' } },
  ],
  aruba_switch: [
    { label: 'NTP sync enabled',     category: 'Time',       rule: { type: 'contains',      pattern: 'timesync ntp',                     description: 'NTP time synchronization must be enabled' },           example: 'timesync ntp' },
    { label: 'NTP server',           category: 'Time',       rule: { type: 'regex_present', pattern: 'ntp server \\S+',                  description: 'NTP server address must be configured' },              example: 'ntp server priority 1 10.0.0.1' },
    { label: 'SSH crypto keys',      category: 'Security',   rule: { type: 'regex_present', pattern: 'crypto key generate',              description: 'SSH RSA crypto keys must be generated' },              example: 'crypto key generate ssh rsa bits 2048' },
    { label: 'Telnet disabled',      category: 'Security',   rule: { type: 'regex_present', pattern: 'no telnet-server',                 description: 'Telnet server must be explicitly disabled' },          example: 'no telnet-server' },
    { label: 'Auth mgmt IPs',        category: 'Security',   rule: { type: 'regex_present', pattern: 'ip authorized-managers',           description: 'Management access must be restricted to authorized IPs' } },
    { label: 'Login banner',         category: 'Security',   rule: { type: 'regex_present', pattern: 'banner motd',                      description: 'MOTD banner must be configured' } },
    { label: 'RADIUS server',        category: 'Auth',       rule: { type: 'regex_present', pattern: 'radius-server host',               description: 'RADIUS authentication server must be configured' } },
    { label: 'Password min-length',  category: 'Auth',       rule: { type: 'regex_present', pattern: 'password minimum-length',          description: 'Minimum password length must be enforced' } },
    { label: 'Syslog server',        category: 'Logging',    rule: { type: 'regex_present', pattern: 'logging \\d+\\.\\d+\\.\\d+\\.\\d+', description: 'Remote syslog server must be configured' },          example: 'logging 10.0.0.5' },
    { label: 'SNMP community',       category: 'Monitoring', rule: { type: 'regex_present', pattern: 'snmp-server community',            description: 'SNMP community must be configured' } },
  ],
  junos: [
    { label: 'SSH service',          category: 'Security',   rule: { type: 'contains',      pattern: 'set system services ssh',          description: 'SSH management service must be enabled' },             example: 'set system services ssh' },
    { label: 'No telnet service',    category: 'Security',   rule: { type: 'regex_absent',  pattern: 'set system services telnet',       description: 'Telnet service must not be configured' } },
    { label: 'No HTTP mgmt',         category: 'Security',   rule: { type: 'regex_absent',  pattern: 'set system services web-management http', description: 'HTTP management must not be configured (use HTTPS)' } },
    { label: 'Login message',        category: 'Security',   rule: { type: 'regex_present', pattern: 'set system login message',         description: 'Login message (banner) must be configured' } },
    { label: 'RADIUS server',        category: 'Auth',       rule: { type: 'regex_present', pattern: 'set system radius-server \\S+',   description: 'RADIUS server must be configured' } },
    { label: 'NTP server',           category: 'Time',       rule: { type: 'regex_present', pattern: 'set system ntp server \\S+',      description: 'NTP server must be configured' },                      example: 'set system ntp server 10.0.0.1' },
    { label: 'Syslog host',          category: 'Logging',    rule: { type: 'regex_present', pattern: 'set system syslog host \\S+',     description: 'Remote syslog host must be configured' },              example: 'set system syslog host 10.0.0.5 any any' },
    { label: 'SNMP community',       category: 'Monitoring', rule: { type: 'regex_present', pattern: 'set snmp community \\S+',         description: 'SNMP community must be configured' } },
    { label: 'Domain name',          category: 'Identity',   rule: { type: 'regex_present', pattern: 'set system domain-name \\S+',     description: 'Domain name must be set' } },
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major:    'bg-orange-100 text-orange-700',
  minor:    'bg-yellow-100 text-yellow-700',
  warning:  'bg-yellow-50 text-yellow-600',
  info:     'bg-blue-50 text-blue-600',
}

const STATUS_STYLE: Record<string, string> = {
  pass:  'bg-green-100 text-green-700',
  fail:  'bg-red-100 text-red-700',
  error: 'bg-slate-100 text-slate-500',
}

function scoreStyle(score: number) {
  if (score >= 90) return { badge: 'bg-green-100 text-green-700', bar: '#16a34a' }
  if (score >= 70) return { badge: 'bg-yellow-100 text-yellow-700', bar: '#ca8a04' }
  return { badge: 'bg-red-100 text-red-700', bar: '#dc2626' }
}

// ── Compliance result row ─────────────────────────────────────────────────────

function ResultRow({ result }: { result: ReturnType<typeof useQuery<any>>['data'] extends any[] ? ReturnType<typeof useQuery<any>>['data'][number] : never }) {
  const [open, setOpen] = useState(false)
  const fails = (result.findings as ComplianceRule[]).filter((f: any) => f.status === 'fail')

  return (
    <div className={`border-b border-slate-50 last:border-0 ${result.status === 'fail' ? 'bg-red-50/30' : ''}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize shrink-0 ${STATUS_STYLE[result.status] ?? STATUS_STYLE.error}`}>
          {result.status}
        </span>
        <Link to={`/devices/${result.device_id}`} onClick={e => e.stopPropagation()}
          className="text-sm font-medium text-slate-700 hover:text-blue-600 transition-colors w-36 truncate shrink-0">
          {result.device_name}
        </Link>
        <span className="text-xs text-slate-600 flex-1 truncate">{result.policy_name}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded capitalize shrink-0 ${SEV_STYLE[result.severity] ?? SEV_STYLE.warning}`}>
          {result.severity}
        </span>
        {result.status === 'fail' && (
          <span className="text-[10px] text-red-500 shrink-0">{fails.length} failing</span>
        )}
        <span className="text-xs text-slate-400 shrink-0">{formatAge(result.checked_at)}</span>
        <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-1.5">
          {(result.findings as any[]).map((f: any, i: number) => (
            <div key={i} className={`flex items-start gap-2.5 px-3 py-2 rounded-lg text-xs ${
              f.status === 'pass' ? 'bg-green-50' : f.status === 'fail' ? 'bg-red-50' : 'bg-slate-50'
            }`}>
              <span className={`shrink-0 font-semibold ${f.status === 'pass' ? 'text-green-600' : f.status === 'fail' ? 'text-red-600' : 'text-slate-500'}`}>
                {f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '!'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-700">{f.description}</p>
                {f.matched_text && <p className="font-mono text-[10px] text-slate-500 mt-0.5 truncate">{f.matched_text}</p>}
                {f.error && <p className="text-red-500 mt-0.5">{f.error}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Golden config drift result row ────────────────────────────────────────────

function GoldenResultRow({ result }: { result: GoldenConfigResult }) {
  const [open, setOpen] = useState(false)
  const score = Number(result.score)
  const style = scoreStyle(score)

  return (
    <div className={`border-b border-slate-50 last:border-0 ${score < 70 ? 'bg-red-50/30' : ''}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${style.badge}`}>
          {score.toFixed(0)}%
        </span>
        <Link to={`/devices/${result.device_id}`} onClick={e => e.stopPropagation()}
          className="text-sm font-medium text-slate-700 hover:text-blue-600 transition-colors w-36 truncate shrink-0">
          {result.device_name}
        </Link>
        <span className="text-xs text-slate-600 flex-1 truncate">{result.golden_config_name}</span>
        <div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden shrink-0">
          <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: style.bar }} />
        </div>
        <span className="text-xs text-slate-400 shrink-0 w-24 text-right">{result.matched_lines}/{result.total_lines} lines</span>
        <span className="text-xs text-slate-400 shrink-0">{formatAge(result.checked_at)}</span>
        <svg className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      {open && (
        <div className="px-5 pb-4">
          {result.missing_lines.length === 0 ? (
            <p className="text-xs text-green-600 px-3 py-2">All golden lines present.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Missing lines ({result.missing_lines.length})</p>
              {result.missing_lines.map((line, i) => (
                <div key={i} className="font-mono text-[11px] text-red-700 bg-red-50 px-3 py-1.5 rounded-lg whitespace-pre-wrap">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Policy form ───────────────────────────────────────────────────────────────

const RULE_TYPES = [
  { value: 'regex_present', label: 'Must match (regex)'         },
  { value: 'regex_absent',  label: 'Must not match (regex)'     },
  { value: 'contains',      label: 'Must contain (literal)'     },
  { value: 'not_contains',  label: 'Must not contain (literal)' },
]

interface PolicyFormProps {
  initial?: Partial<CompliancePolicy>
  onSave: (data: Partial<CompliancePolicy>) => void
  onCancel: () => void
  saving: boolean
}

function PolicyForm({ initial, onSave, onCancel, saving }: PolicyFormProps) {
  const [name,           setName]           = useState(initial?.name ?? '')
  const [description,    setDescription]    = useState(initial?.description ?? '')
  const [severity,       setSeverity]       = useState(initial?.severity ?? 'warning')
  const [rules,          setRules]          = useState<ComplianceRule[]>(initial?.rules ?? [])
  const [targetVendors,  setTargetVendors]  = useState<string[]>((initial?.device_selector as any)?.vendors ?? [])
  const [templateVendor, setTemplateVendor] = useState('all')

  const { data: devicesResp } = useQuery({ queryKey: ['devices-all'], queryFn: () => fetchDevices({ limit: 500 }) })
  const fleetVendors = useMemo(() =>
    [...new Set(((devicesResp as any)?.items ?? devicesResp ?? []).map((d: any) => d.vendor).filter(Boolean) as string[])].sort()
  , [devicesResp])

  const toggleTargetVendor = (v: string) =>
    setTargetVendors(vs => vs.includes(v) ? vs.filter(x => x !== v) : [...vs, v])

  const addRule    = () => setRules(r => [...r, { type: 'regex_present', pattern: '', description: '' }])
  const removeRule = (i: number) => setRules(r => r.filter((_, j) => j !== i))
  const updateRule = (i: number, field: keyof ComplianceRule, value: string) =>
    setRules(r => r.map((rule, j) => j === i ? { ...rule, [field]: value } : rule))

  const isAbsent = (type: string) => type === 'regex_absent' || type === 'not_contains'

  const validatePattern = (pattern: string, type: string): boolean | null => {
    if (!pattern || type === 'contains' || type === 'not_contains') return null
    try { new RegExp(pattern, 'im'); return true }
    catch { return false }
  }

  const currentTemplates = COMPLIANCE_TEMPLATES[templateVendor] ?? COMPLIANCE_TEMPLATES.all
  const grouped = currentTemplates.reduce<Record<string, RuleTemplate[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t); return acc
  }, {})

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="space-y-5">
      {/* Name + Severity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Policy name *</label>
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="IOS Security Baseline" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Severity</label>
          <select value={severity} onChange={e => setSeverity(e.target.value)} className={inputCls}>
            {['critical','major','minor','warning','info'].map(s => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Optional description" />
      </div>

      {/* Applies to */}
      {fleetVendors.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Applies to</label>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setTargetVendors([])}
              className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                targetVendors.length === 0
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700'
              }`}>
              All devices
            </button>
            {fleetVendors.map(v => (
              <button key={v} type="button" onClick={() => toggleTargetVendor(v)}
                className={`px-2.5 py-1 rounded-lg text-xs border capitalize transition-colors ${
                  targetVendors.includes(v)
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700'
                }`}>
                {v}
              </button>
            ))}
          </div>
          {targetVendors.length > 0 && (
            <p className="text-[10px] text-slate-400 mt-1">Only evaluated against {targetVendors.join(', ')} devices</p>
          )}
        </div>
      )}

      {/* Template library */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-slate-600">Add rule from template</label>
          <span className="text-[10px] text-slate-400 flex items-center gap-2">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-100 border border-emerald-300" />must have
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-100 border border-rose-300" />must not have
            </span>
          </span>
        </div>

        {/* Vendor tabs */}
        <div className="flex gap-1 mb-3 overflow-x-auto pb-0.5 scrollbar-none">
          {TEMPLATE_VENDORS.map(v => (
            <button key={v.key} type="button" onClick={() => setTemplateVendor(v.key)}
              className={`px-2.5 py-1 rounded-md text-[11px] whitespace-nowrap border transition-colors shrink-0 ${
                templateVendor === v.key
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-slate-200 text-slate-500 bg-white hover:border-slate-400 hover:text-slate-700'
              }`}>
              {v.label}
            </button>
          ))}
        </div>

        {/* Categorized chips */}
        <div className="space-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
          {Object.entries(grouped).map(([category, templates]) => (
            <div key={category}>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">{category}</p>
              <div className="flex flex-wrap gap-1.5">
                {templates.map(t => {
                  const absent = isAbsent(t.rule.type)
                  return (
                    <button key={t.label} type="button"
                      title={t.example ? `e.g. ${t.example}` : t.rule.description}
                      onClick={() => setRules(r => [...r, { ...t.rule }])}
                      className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors ${
                        absent
                          ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:border-rose-400'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400'
                      }`}>
                      + {t.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Rules list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-slate-600">Rules ({rules.length})</label>
          <button onClick={addRule} className="text-xs text-blue-600 hover:underline">+ Blank rule</button>
        </div>
        <div className="space-y-2">
          {rules.map((rule, i) => {
            const absent   = isAbsent(rule.type)
            const patValid = validatePattern(rule.pattern, rule.type)
            return (
              <div key={i} className={`border rounded-lg bg-white relative overflow-hidden ${absent ? 'border-rose-200' : 'border-emerald-200'}`}>
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${absent ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                <div className="pl-3 pr-3 pt-2.5 pb-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <select value={rule.type} onChange={e => updateRule(i, 'type', e.target.value)}
                      className={`border rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 flex-1 ${
                        absent ? 'border-rose-200 text-rose-700' : 'border-emerald-200 text-emerald-700'
                      }`}>
                      {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <button onClick={() => removeRule(i)} className="text-slate-300 hover:text-red-500 transition-colors shrink-0">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                  </div>
                  <div className="relative">
                    <input value={rule.pattern} onChange={e => updateRule(i, 'pattern', e.target.value)}
                      placeholder={
                        rule.type === 'contains' || rule.type === 'not_contains'
                          ? 'Exact text to match'
                          : 'Regex pattern — multiline, case-insensitive'
                      }
                      className={`w-full border rounded-lg px-3 py-1.5 text-xs font-mono bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 pr-7 ${
                        patValid === false ? 'border-red-300 bg-red-50' : 'border-slate-200'
                      }`} />
                    {patValid !== null && (
                      <span className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold ${patValid ? 'text-emerald-500' : 'text-red-500'}`}>
                        {patValid ? '✓' : '✗'}
                      </span>
                    )}
                  </div>
                  <input value={rule.description ?? ''} onChange={e => updateRule(i, 'description', e.target.value)}
                    placeholder="Description shown in compliance report"
                    className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  {patValid === false && (
                    <p className="text-[10px] text-red-500">Invalid regular expression</p>
                  )}
                </div>
              </div>
            )
          })}
          {rules.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-5 border border-dashed border-slate-200 rounded-lg">
              No rules yet — pick from templates above or use <span className="font-medium">+ Blank rule</span>
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
        <button
          onClick={() => {
            const device_selector = targetVendors.length > 0 ? { vendors: targetVendors } : null
            onSave({ name, description: description || undefined, severity, rules, is_enabled: true, device_selector })
          }}
          disabled={saving || !name}
          className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </div>
  )
}

// ── Golden config form ────────────────────────────────────────────────────────

interface GoldenConfigFormProps {
  initial?: Partial<GoldenConfig>
  onSave: (data: Partial<GoldenConfig>) => void
  onCancel: () => void
  saving: boolean
}

function GoldenConfigForm({ initial, onSave, onCancel, saving }: GoldenConfigFormProps) {
  const [name,          setName]          = useState(initial?.name ?? '')
  const [description,   setDescription]   = useState(initial?.description ?? '')
  const [templateText,  setTemplateText]  = useState(initial?.template_text ?? '')
  const [targetVendors, setTargetVendors] = useState<string[]>((initial?.device_selector as any)?.vendors ?? [])
  const [loadDeviceId,  setLoadDeviceId]  = useState('')
  const [loading,       setLoading]       = useState(false)

  const { data: devicesResp } = useQuery({ queryKey: ['devices-all'], queryFn: () => fetchDevices({ limit: 500 }) })
  const allDevices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []
  const fleetVendors = useMemo(() =>
    [...new Set(allDevices.map((d: any) => d.vendor).filter(Boolean) as string[])].sort()
  , [allDevices])

  const toggleTargetVendor = (v: string) =>
    setTargetVendors(vs => vs.includes(v) ? vs.filter(x => x !== v) : [...vs, v])

  const loadFromDevice = async () => {
    if (!loadDeviceId) return
    setLoading(true)
    try {
      const backups = await fetchBackups(loadDeviceId, 1)
      if (backups.length === 0) return
      const full = await fetchBackup(backups[0].id)
      setTemplateText(full.config_text)
    } finally {
      setLoading(false)
    }
  }

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const lineCount = templateText.split('\n').filter(l => {
    const t = l.trim()
    return t && !t.startsWith('!') && !t.startsWith('#')
  }).length

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="Arista leaf baseline" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Optional description" />
        </div>
      </div>

      {/* Applies to */}
      {fleetVendors.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">Applies to</label>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setTargetVendors([])}
              className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                targetVendors.length === 0
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700'
              }`}>
              All devices
            </button>
            {fleetVendors.map(v => (
              <button key={v} type="button" onClick={() => toggleTargetVendor(v)}
                className={`px-2.5 py-1 rounded-lg text-xs border capitalize transition-colors ${
                  targetVendors.includes(v)
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-700'
                }`}>
                {v}
              </button>
            ))}
          </div>
          {targetVendors.length > 0 && (
            <p className="text-[10px] text-slate-400 mt-1">Only evaluated against {targetVendors.join(', ')} devices</p>
          )}
        </div>
      )}

      {/* Load from device */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-600 mb-1">Load template from a device's latest backup</label>
          <select value={loadDeviceId} onChange={e => setLoadDeviceId(e.target.value)} className={inputCls}>
            <option value="">Select a device…</option>
            {allDevices.map((d: any) => <option key={d.id} value={d.id}>{d.fqdn ?? d.hostname}</option>)}
          </select>
        </div>
        <button type="button" onClick={loadFromDevice} disabled={!loadDeviceId || loading}
          className="px-3 py-2 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 shrink-0">
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      {/* Template */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium text-slate-600">Golden template</label>
          <span className="text-[10px] text-slate-400">{lineCount} line{lineCount !== 1 ? 's' : ''} · {'{{var}}'} placeholders supported (hostname, mgmt_ip, vendor, device_type, fqdn)</span>
        </div>
        <textarea value={templateText} onChange={e => setTemplateText(e.target.value)}
          spellCheck={false} rows={14}
          placeholder={'ntp server {{ntp_server}}\nlogging host 10.0.0.5\n!\n# Lines starting with ! or # are ignored'}
          className="w-full border border-slate-200 rounded-xl px-4 py-3 font-mono text-xs bg-slate-950 text-green-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y leading-relaxed" />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-xl transition-colors">Cancel</button>
        <button
          onClick={() => {
            const device_selector = targetVendors.length > 0 ? { vendors: targetVendors } : null
            onSave({ name, description: description || undefined, template_text: templateText, is_enabled: true, device_selector })
          }}
          disabled={saving || !name}
          className="px-4 py-2 text-sm font-medium bg-slate-800 text-white rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : 'Save golden config'}
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type View = 'compliance' | 'policies' | 'deploy' | 'golden' | 'git'

export default function ConfigPage() {
  const qc = useQueryClient()
  const role    = useRole()
  const canEdit = hasRole(role, 'admin')
  const [view,        setView]        = useState<View>('compliance')
  const [showForm,    setShowForm]    = useState(false)
  const [editPolicy,  setEditPolicy]  = useState<CompliancePolicy | null>(null)
  const [confirmDel,  setConfirmDel]  = useState<string | null>(null)
  const [runResult,   setRunResult]   = useState<Record<string, number> | null>(null)

  const [showGoldenForm,   setShowGoldenForm]   = useState(false)
  const [editGolden,       setEditGolden]       = useState<GoldenConfig | null>(null)
  const [confirmDelGolden, setConfirmDelGolden] = useState<string | null>(null)
  const [goldenRunResult,  setGoldenRunResult]  = useState<{ id: string; evaluated: number; skipped: number; avg_score: number | null } | null>(null)

  const { data: results = [], isLoading: resultsLoading } = useQuery({
    queryKey: ['compliance-results'],
    queryFn:  () => fetchComplianceResults(),
    refetchInterval: 60_000,
  })

  const { data: policies = [], isLoading: policiesLoading } = useQuery({
    queryKey: ['compliance-policies'],
    queryFn:  fetchPolicies,
  })

  const { data: goldenConfigs = [], isLoading: goldenLoading } = useQuery({
    queryKey: ['golden-configs'],
    queryFn:  fetchGoldenConfigs,
  })

  const { data: goldenResults = [], isLoading: goldenResultsLoading } = useQuery({
    queryKey: ['golden-config-results'],
    queryFn:  () => fetchGoldenConfigResults(),
    refetchInterval: 60_000,
  })

  const createMut = useMutation({
    mutationFn: createPolicy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setShowForm(false) },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CompliancePolicy> }) => updatePolicy(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setEditPolicy(null) },
  })

  const deleteMut = useMutation({
    mutationFn: deletePolicy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['compliance-policies'] }); setConfirmDel(null) },
  })

  const runMut = useMutation({
    mutationFn: runPolicy,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['compliance-results'] })
      setRunResult(data)
      setTimeout(() => setRunResult(null), 5000)
    },
  })

  const createGoldenMut = useMutation({
    mutationFn: createGoldenConfig,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['golden-configs'] }); setShowGoldenForm(false) },
  })

  const updateGoldenMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<GoldenConfig> }) => updateGoldenConfig(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['golden-configs'] }); setEditGolden(null) },
  })

  const deleteGoldenMut = useMutation({
    mutationFn: deleteGoldenConfig,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['golden-configs'] })
      qc.invalidateQueries({ queryKey: ['golden-config-results'] })
      setConfirmDelGolden(null)
    },
  })

  const runGoldenMut = useMutation({
    mutationFn: runGoldenConfig,
    onSuccess: (data, id) => {
      qc.invalidateQueries({ queryKey: ['golden-config-results'] })
      setGoldenRunResult({ id, ...data })
      setTimeout(() => setGoldenRunResult(null), 5000)
    },
  })

  const failCount = results.filter(r => r.status === 'fail').length
  const passCount = results.filter(r => r.status === 'pass').length
  const driftCount = goldenResults.filter(r => Number(r.score) < 100).length

  const NAV_ITEMS: { id: View; label: string; desc: string; icon: React.ReactNode }[] = [
    {
      id: 'compliance',
      label: 'Compliance',
      desc: 'Audit results across all devices',
      icon: (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622C17.176 19.29 21 14.591 21 9c0-1.052-.135-2.078-.382-3.016z"/>
        </svg>
      ),
    },
    {
      id: 'policies',
      label: 'Policies',
      desc: 'Define compliance rules',
      icon: (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4"/>
        </svg>
      ),
    },
    {
      id: 'deploy',
      label: 'Deploy',
      desc: 'Push config to multiple devices',
      icon: (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12"/>
        </svg>
      ),
    },
    {
      id: 'golden',
      label: 'Golden Config',
      desc: 'Drift score against a baseline template',
      icon: (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/>
        </svg>
      ),
    },
    {
      id: 'git',
      label: 'Git Archive',
      desc: 'Version-controlled config history',
      icon: (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/>
          <path d="M6 8.5v7M8.5 6H14a4 4 0 0 1 4 4v5.5"/>
        </svg>
      ),
    },
  ]

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-52 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col overflow-y-auto">
        {/* Sidebar header */}
        <div className="px-5 pt-5 pb-4 border-b border-slate-200">
          <p className="text-sm font-semibold text-slate-800 leading-tight">Config Management</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Backup, diff, and compliance</p>
        </div>

        {/* Nav section */}
        <div className="pt-4 pb-2">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest px-5 mb-1">Views</p>
          <nav className="flex flex-col">
            {NAV_ITEMS.map(item => {
              const active = view === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`w-full flex items-start gap-2.5 px-5 py-2.5 text-left transition-colors relative ${
                    active
                      ? 'bg-white text-slate-800 font-medium border-r-2 border-blue-500'
                      : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
                  }`}
                >
                  <span className={`mt-0.5 ${active ? 'text-blue-500' : ''}`}>{item.icon}</span>
                  <span className="flex flex-col min-w-0">
                    <span className="flex items-center gap-1.5 text-xs leading-tight">
                      {item.label}
                      {item.id === 'compliance' && failCount > 0 && (
                        <span className="bg-red-500 text-white text-[9px] font-bold rounded-full px-1.5 leading-4">{failCount}</span>
                      )}
                      {item.id === 'golden' && driftCount > 0 && (
                        <span className="bg-amber-500 text-white text-[9px] font-bold rounded-full px-1.5 leading-4">{driftCount}</span>
                      )}
                    </span>
                    <span className="text-[10px] text-slate-400 mt-0.5 leading-tight font-normal">{item.desc}</span>
                  </span>
                </button>
              )
            })}
          </nav>
        </div>
      </aside>

      {/* Content area */}
      <div className="flex-1 min-w-0 overflow-y-auto flex flex-col">
        {/* Page header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-semibold text-slate-800">
              {NAV_ITEMS.find(n => n.id === view)?.label}
            </h1>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {NAV_ITEMS.find(n => n.id === view)?.desc}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {runResult && (
              <div className="text-xs text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                Ran: {runResult.pass ?? 0} pass · {runResult.fail ?? 0} fail · {runResult.skip ?? 0} skip
              </div>
            )}
            {goldenRunResult && (
              <div className="text-xs text-slate-600 bg-slate-100 px-3 py-1 rounded-lg">
                Ran: {goldenRunResult.evaluated} evaluated · {goldenRunResult.skipped} skipped
                {goldenRunResult.avg_score !== null && <> · avg {goldenRunResult.avg_score.toFixed(0)}%</>}
              </div>
            )}
            {canEdit && view === 'policies' && (
              <button onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                New policy
              </button>
            )}
            {canEdit && view === 'golden' && (
              <button onClick={() => setShowGoldenForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                New golden config
              </button>
            )}
          </div>
        </div>

        <div className="p-6">
          {view === 'compliance' && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                {[
                  { label: 'Failing',  value: failCount, accent: failCount > 0 ? '#dc2626' : '#94a3b8' },
                  { label: 'Passing',  value: passCount, accent: '#16a34a' },
                  { label: 'Policies', value: policies.length, accent: '#6366f1' },
                  { label: 'Devices checked', value: new Set(results.map(r => r.device_id)).size, accent: '#0891b2' },
                ].map(c => (
                  <div key={c.label} className="relative bg-white rounded-xl border border-slate-200 px-4 py-3 overflow-hidden">
                    <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" style={{ backgroundColor: c.accent }} />
                    <p className="text-xs text-slate-400 mb-1">{c.label}</p>
                    <p className="text-2xl font-bold text-slate-800">{c.value}</p>
                  </div>
                ))}
              </div>

              {/* Results table */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">Compliance results</h2>
                  <span className="text-xs text-slate-400">{results.length} checks</span>
                </div>
                {resultsLoading ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
                ) : results.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-sm text-slate-400">No compliance results yet</p>
                    <p className="text-xs text-slate-300 mt-1">Create a policy and run it, or wait for the hourly collection cycle</p>
                  </div>
                ) : (
                  <div>
                    {results.map(r => <ResultRow key={r.id} result={r as any} />)}
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'policies' && (
            <>
              {/* Create form */}
              {showForm && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-5">
                  <h3 className="text-sm font-semibold text-slate-800 mb-4">New compliance policy</h3>
                  <PolicyForm
                    onSave={data => createMut.mutate(data)}
                    onCancel={() => setShowForm(false)}
                    saving={createMut.isPending}
                  />
                </div>
              )}

              {/* Edit form */}
              {editPolicy && (
                <div className="bg-white rounded-2xl border border-blue-200 p-6 mb-5">
                  <h3 className="text-sm font-semibold text-slate-800 mb-4">Edit — {editPolicy.name}</h3>
                  <PolicyForm
                    initial={editPolicy}
                    onSave={data => updateMut.mutate({ id: editPolicy.id, data })}
                    onCancel={() => setEditPolicy(null)}
                    saving={updateMut.isPending}
                  />
                </div>
              )}

              {/* Policy list */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-100">
                  <h2 className="text-sm font-semibold text-slate-800">Policies ({policies.length})</h2>
                </div>
                {policiesLoading ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
                ) : policies.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-sm text-slate-400">No policies yet</p>
                    {canEdit && (
                      <button onClick={() => setShowForm(true)} className="mt-2 text-sm text-blue-600 hover:underline">
                        Create your first policy
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {policies.map(p => (
                      <div key={p.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-800">{p.name}</span>
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize ${SEV_STYLE[p.severity] ?? SEV_STYLE.warning}`}>{p.severity}</span>
                            {!p.is_enabled && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">disabled</span>}
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {p.rules.length} rule{p.rules.length !== 1 ? 's' : ''}
                            {(p.device_selector as any)?.vendors?.length > 0 && (
                              <span className="ml-1.5 text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded capitalize">
                                {(p.device_selector as any).vendors.join(', ')}
                              </span>
                            )}
                            {p.description ? ` · ${p.description}` : ''}
                          </p>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => runMut.mutate(p.id)} disabled={runMut.isPending}
                              className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
                              {runMut.isPending ? 'Running…' : 'Run'}
                            </button>
                            <button onClick={() => setEditPolicy(p)}
                              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            {confirmDel === p.id ? (
                              <>
                                <button onClick={() => deleteMut.mutate(p.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                                <button onClick={() => setConfirmDel(null)} className="text-xs text-slate-400 hover:underline ml-1">Cancel</button>
                              </>
                            ) : (
                              <button onClick={() => setConfirmDel(p.id)}
                                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'golden' && (
            <>
              {/* Create form */}
              {showGoldenForm && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-5">
                  <h3 className="text-sm font-semibold text-slate-800 mb-4">New golden config</h3>
                  <GoldenConfigForm
                    onSave={data => createGoldenMut.mutate(data)}
                    onCancel={() => setShowGoldenForm(false)}
                    saving={createGoldenMut.isPending}
                  />
                </div>
              )}

              {/* Edit form */}
              {editGolden && (
                <div className="bg-white rounded-2xl border border-blue-200 p-6 mb-5">
                  <h3 className="text-sm font-semibold text-slate-800 mb-4">Edit — {editGolden.name}</h3>
                  <GoldenConfigForm
                    initial={editGolden}
                    onSave={data => updateGoldenMut.mutate({ id: editGolden.id, data })}
                    onCancel={() => setEditGolden(null)}
                    saving={updateGoldenMut.isPending}
                  />
                </div>
              )}

              {/* Golden config list */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6">
                <div className="px-5 py-3.5 border-b border-slate-100">
                  <h2 className="text-sm font-semibold text-slate-800">Golden configs ({goldenConfigs.length})</h2>
                </div>
                {goldenLoading ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
                ) : goldenConfigs.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-sm text-slate-400">No golden configs yet</p>
                    {canEdit && (
                      <button onClick={() => setShowGoldenForm(true)} className="mt-2 text-sm text-blue-600 hover:underline">
                        Create your first golden config
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {goldenConfigs.map(g => {
                      const lineCount = g.template_text.split('\n').filter(l => {
                        const t = l.trim()
                        return t && !t.startsWith('!') && !t.startsWith('#')
                      }).length
                      return (
                        <div key={g.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-800">{g.name}</span>
                              {!g.is_enabled && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">disabled</span>}
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {lineCount} line{lineCount !== 1 ? 's' : ''}
                              {(g.device_selector as any)?.vendors?.length > 0 && (
                                <span className="ml-1.5 text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded capitalize">
                                  {(g.device_selector as any).vendors.join(', ')}
                                </span>
                              )}
                              {g.description ? ` · ${g.description}` : ''}
                            </p>
                          </div>
                          {canEdit && (
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => runGoldenMut.mutate(g.id)} disabled={runGoldenMut.isPending}
                                className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
                                {runGoldenMut.isPending ? 'Running…' : 'Run'}
                              </button>
                              <button onClick={() => setEditGolden(g)}
                                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                              </button>
                              {confirmDelGolden === g.id ? (
                                <>
                                  <button onClick={() => deleteGoldenMut.mutate(g.id)} className="text-xs text-red-600 hover:underline font-medium">Confirm</button>
                                  <button onClick={() => setConfirmDelGolden(null)} className="text-xs text-slate-400 hover:underline ml-1">Cancel</button>
                                </>
                              ) : (
                                <button onClick={() => setConfirmDelGolden(g.id)}
                                  className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/></svg>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Drift results table */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-800">Drift results</h2>
                  <span className="text-xs text-slate-400">{goldenResults.length} checks</span>
                </div>
                {goldenResultsLoading ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>
                ) : goldenResults.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-sm text-slate-400">No drift results yet</p>
                    <p className="text-xs text-slate-300 mt-1">Create a golden config and run it, or wait for the next collection cycle</p>
                  </div>
                ) : (
                  <div>
                    {goldenResults.map(r => <GoldenResultRow key={r.id} result={r} />)}
                  </div>
                )}
              </div>
            </>
          )}

          {view === 'git' && <GitArchiveTab />}

          {view === 'deploy' && <MultiDeployTab />}
        </div>
      </div>
    </div>
  )
}

// ── Multi-device deploy tab ───────────────────────────────────────────────────

function MultiDeployTab() {
  const [scopeType, setScopeType]   = useState<'all' | 'vendor' | 'tag' | 'devices'>('all')
  const [scopeValue, setScopeValue] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [commands, setCommands]     = useState('')
  const [variables, setVariables]   = useState<{ key: string; value: string }[]>([
    { key: 'ntp_server',    value: '' },
    { key: 'syslog_server', value: '' },
  ])
  const [save, setSave]             = useState(true)
  const [result, setResult]         = useState<{ results: MultiDeployDeviceResult[]; succeeded: number; failed: number } | null>(null)
  const [deploying, setDeploying]   = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // Fetch devices for preview and vendor detection
  const { data: devicesResp } = useQuery({ queryKey: ['devices-all'], queryFn: () => fetchDevices({ limit: 500 }) })
  const allDevices: any[] = (devicesResp as any)?.items ?? devicesResp ?? []

  // Compute targeted devices for preview
  const targetedDevices = useMemo(() => {
    if (scopeType === 'all') return allDevices
    if (scopeType === 'vendor') return allDevices.filter((d: any) => d.vendor?.toLowerCase().includes(scopeValue.toLowerCase()) && scopeValue)
    if (scopeType === 'tag') return allDevices.filter((d: any) => (d.tags || []).includes(scopeValue) && scopeValue)
    if (scopeType === 'devices') return allDevices.filter((d: any) => selectedIds.includes(d.id))
    return []
  }, [allDevices, scopeType, scopeValue, selectedIds])

  // Get unique vendors for smart snippets
  const vendors = useMemo(() => [...new Set(targetedDevices.map((d: any) => d.vendor).filter(Boolean))], [targetedDevices])
  const snippets = getSnippets(vendors as string[])

  const buildSelector = (): Record<string, unknown> | null => {
    if (scopeType === 'all') return null
    if (scopeType === 'vendor' && scopeValue) return { vendors: [scopeValue] }
    if (scopeType === 'tag'    && scopeValue) return { tags:    [scopeValue]  }
    if (scopeType === 'devices' && selectedIds.length) return { device_ids: selectedIds }
    return null
  }

  const varMap = Object.fromEntries(variables.filter(v => v.key && v.value).map(v => [v.key, v.value]))

  const handleDeploy = async () => {
    const lines = commands.split('\n').filter(l => l.trim())
    if (!lines.length) return
    if (!targetedDevices.length && scopeType !== 'all') { setError('No devices match the selector'); return }
    setDeploying(true); setResult(null); setError(null)
    try {
      const res = await deployConfigMulti({
        commands: lines,
        device_selector: buildSelector(),
        variables: varMap,
        save,
      })
      setResult(res)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? String(e))
    } finally {
      setDeploying(false)
    }
  }

  const inputCls = "border border-slate-200 rounded-lg px-3 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

  return (
    <div className="max-w-4xl space-y-5">
      {/* Warning */}
      <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        <p className="text-xs text-amber-700">Commands are pushed directly to all matching devices. Test in a lab first. Vendor-specific config mode entry/exit is handled automatically.</p>
      </div>

      {/* Scope selector */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">Target devices</h3>
        <div className="flex gap-2 flex-wrap">
          {(['all','vendor','tag','devices'] as const).map(t => (
            <button key={t} onClick={() => { setScopeType(t); setScopeValue(''); setSelectedIds([]) }}
              className={`px-3 py-1.5 text-xs rounded-lg border capitalize transition-colors ${scopeType === t ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
              {t === 'all' ? 'All devices' : `By ${t}`}
            </button>
          ))}
        </div>

        {scopeType === 'vendor' && (
          <div className="flex gap-2 flex-wrap">
            {[...new Set(allDevices.map((d: any) => d.vendor).filter(Boolean))].map(v => (
              <button key={v as string} onClick={() => setScopeValue(v as string)}
                className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${scopeValue === v ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>
                {v as string}
              </button>
            ))}
          </div>
        )}

        {scopeType === 'tag' && (
          <input value={scopeValue} onChange={e => setScopeValue(e.target.value)}
            placeholder="Enter tag name" className={`${inputCls} w-48`} />
        )}

        {scopeType === 'devices' && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {allDevices.map((d: any) => (
              <label key={d.id} className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 px-2 py-1 rounded">
                <input type="checkbox" checked={selectedIds.includes(d.id)}
                  onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, d.id] : ids.filter(i => i !== d.id))}
                  className="rounded border-slate-300" />
                <span className="text-xs text-slate-700">{d.fqdn ?? d.hostname}</span>
                <span className="text-[10px] text-slate-400">{d.vendor}</span>
              </label>
            ))}
          </div>
        )}

        {/* Preview count */}
        <p className="text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{targetedDevices.length}</span> device{targetedDevices.length !== 1 ? 's' : ''} targeted
          {vendors.length > 0 && <span className="ml-1 text-slate-400">· {vendors.join(', ')}</span>}
        </p>
      </div>

      {/* Template variables */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Template variables</h3>
            <p className="text-xs text-slate-400 mt-0.5">Use <code className="bg-slate-100 px-1 rounded">{'{{var}}'}</code> in commands. Built-ins: hostname, mgmt_ip, vendor, device_type</p>
          </div>
          <button onClick={() => setVariables(v => [...v, { key: '', value: '' }])}
            className="text-xs text-blue-600 hover:underline">+ Add</button>
        </div>
        <div className="space-y-2">
          {variables.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={v.key} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,key:e.target.value} : x))}
                placeholder="variable_name" className={`${inputCls} w-36 font-mono`} />
              <span className="text-slate-400 text-xs">=</span>
              <input value={v.value} onChange={e => setVariables(vs => vs.map((x,j) => j===i ? {...x,value:e.target.value} : x))}
                placeholder="value" className={`${inputCls} flex-1`} />
              <button onClick={() => setVariables(vs => vs.filter((_,j) => j!==i))}
                aria-label="Remove variable" className="text-slate-300 hover:text-red-400 transition-colors text-xs">✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Command editor */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">
          Commands
          {vendors.length === 1 && <span className="ml-2 text-[10px] font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full capitalize">{vendors[0]} syntax</span>}
          {vendors.length > 1  && <span className="ml-2 text-[10px] font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">generic syntax (mixed vendors)</span>}
        </h3>

        <div className="flex flex-wrap gap-1.5">
          {snippets.map(s => (
            <button key={s.label} type="button"
              onClick={() => setCommands(c => c ? c + '\n' + s.text : s.text)}
              className="px-2 py-0.5 rounded-md text-[11px] border border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
              + {s.label}
            </button>
          ))}
        </div>

        <textarea value={commands} onChange={e => setCommands(e.target.value)}
          spellCheck={false} rows={8}
          placeholder={'ntp server {{ntp_server}}\nlogging host {{syslog_server}}'}
          className="w-full border border-slate-200 rounded-xl px-4 py-3 font-mono text-xs bg-slate-950 text-green-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y leading-relaxed" />
      </div>

      {/* Deploy controls */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} className="rounded border-slate-300 text-blue-600" />
          <span className="text-xs text-slate-600">Save to startup config</span>
        </label>
        <button onClick={handleDeploy} disabled={deploying || !commands.trim() || targetedDevices.length === 0}
          className="ml-auto flex items-center gap-1.5 px-5 py-2 bg-slate-800 text-white text-xs font-medium rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50">
          {deploying ? (
            <><span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />Deploying to {targetedDevices.length} device{targetedDevices.length !== 1 ? 's' : ''}…</>
          ) : (
            <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>Deploy to {targetedDevices.length} device{targetedDevices.length !== 1 ? 's' : ''}</>
          )}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">{error}</div>}

      {/* Results table */}
      {result && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-800">Deploy results</h3>
            <span className="text-xs text-green-600 font-medium">{result.succeeded} succeeded</span>
            {result.failed > 0 && <span className="text-xs text-red-500 font-medium">{result.failed} failed</span>}
          </div>
          <div className="divide-y divide-slate-50">
            {result.results.map((r, i) => (
              <details key={i} className="group">
                <summary className={`flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-slate-50 transition-colors list-none ${r.success ? '' : 'bg-red-50/40'}`}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${r.success ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-sm font-medium text-slate-700 flex-1">{r.hostname}</span>
                  {r.error && <span className="text-xs text-red-500 truncate max-w-xs">{r.error}</span>}
                  <svg className="w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                </summary>
                {(r.output || r.error) && (
                  <div className="px-5 pb-3">
                    <pre className="text-[11px] font-mono bg-slate-950 text-green-400 p-3 rounded-lg overflow-auto max-h-48 leading-relaxed whitespace-pre-wrap">
                      {r.error || r.output || '(no output)'}
                    </pre>
                  </div>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Git archive tab ───────────────────────────────────────────────────────────

function GitArchiveTab() {
  const qc = useQueryClient()
  const role    = useRole()
  const canEdit = hasRole(role, 'admin')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch]       = useState('main')
  const [pushResult, setPushResult] = useState<{ ok: boolean; error: string | null } | null>(null)

  const { data: gitStatus, isLoading } = useQuery({
    queryKey: ['git-status'],
    queryFn:  fetchGitStatus,
    refetchInterval: 30_000,
  })

  const setRemoteMut = useMutation({
    mutationFn: () => setGitRemote(remoteUrl, branch || 'main'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['git-status'] }); setRemoteUrl('') },
  })

  const removeRemoteMut = useMutation({
    mutationFn: removeGitRemote,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['git-status'] }),
  })

  const pushMut = useMutation({
    mutationFn: pushGitArchive,
    onSuccess: (data) => {
      setPushResult(data)
      qc.invalidateQueries({ queryKey: ['git-status'] })
      setTimeout(() => setPushResult(null), 8000)
    },
  })

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

  if (isLoading) return <div className="text-sm text-slate-400 text-center py-8">Loading…</div>

  return (
    <div className="max-w-2xl space-y-5">
      {/* Repo status */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">Repository status</h3>
        {!gitStatus?.exists ? (
          <p className="text-xs text-slate-400">No commits yet — the archive repo is created automatically when the first config backup is collected.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-slate-400">Commits</p>
              <p className="text-slate-800 font-medium">{gitStatus.commit_count}</p>
            </div>
            <div>
              <p className="text-slate-400">Branch</p>
              <p className="text-slate-800 font-medium">{gitStatus.branch}</p>
            </div>
            {gitStatus.last_commit && (
              <div className="col-span-2">
                <p className="text-slate-400">Last commit</p>
                <p className="text-slate-800 font-mono text-[11px] mt-0.5">{gitStatus.last_commit.hash.slice(0, 10)} · {gitStatus.last_commit.subject}</p>
                <p className="text-slate-400 text-[10px] mt-0.5">{new Date(gitStatus.last_commit.date).toLocaleString()}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Remote */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-800">Remote</h3>
        {gitStatus?.remote_configured ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-600 font-mono break-all">{gitStatus.remote_url_masked}</p>
            {gitStatus.last_push_at && (
              <p className={`text-xs ${gitStatus.last_push_ok === false ? 'text-red-500' : 'text-green-600'}`}>
                Last push {formatAge(gitStatus.last_push_at)}{gitStatus.last_push_ok === false ? ' — failed' : ''}
              </p>
            )}
            {gitStatus.last_push_error && (
              <p className="text-xs text-red-500">{gitStatus.last_push_error}</p>
            )}
            {pushResult && (
              <p className={`text-xs ${pushResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {pushResult.ok ? 'Push succeeded' : `Push failed: ${pushResult.error}`}
              </p>
            )}
            {canEdit && (
              <div className="flex gap-2 pt-1">
                <button onClick={() => pushMut.mutate()} disabled={pushMut.isPending}
                  className="px-3 py-1.5 text-xs bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50">
                  {pushMut.isPending ? 'Pushing…' : 'Push now'}
                </button>
                <button onClick={() => removeRemoteMut.mutate()} disabled={removeRemoteMut.isPending}
                  className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
                  Remove remote
                </button>
              </div>
            )}
          </div>
        ) : canEdit ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">Mirror the config archive to a remote git repository (e.g. GitHub, GitLab, or a bare repo on another server).</p>
            <input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} className={inputCls}
              placeholder="https://user:token@github.com/org/configs.git" />
            <input value={branch} onChange={e => setBranch(e.target.value)} className={inputCls} placeholder="main" />
            <button onClick={() => setRemoteMut.mutate()} disabled={!remoteUrl.trim() || setRemoteMut.isPending}
              className="px-3 py-1.5 text-xs bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors disabled:opacity-50">
              {setRemoteMut.isPending ? 'Saving…' : 'Save remote'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-400">No remote configured.</p>
        )}
      </div>
    </div>
  )
}
