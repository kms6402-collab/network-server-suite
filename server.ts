import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import dns from "dns";
import dgram from "dgram";
import { exec, execFile, spawn } from "child_process";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { Client as SshClient } from "ssh2";
import { Telnet } from "telnet-client";
import { FtpSrv } from "ftp-srv";
import {
  DhcpConfig,
  DhcpLease, 
  DhcpReservation, 
  TftpFtpConfig,
  FtpCredential,
  TransferLog,
  TerminalHost, 
  CommandScript,
  ScriptExecution,
  SystemStatus,
  BatchJob
} from "./src/types.js";

// esbuild bundles this file to CJS for pkg, where import.meta.url is empty
// (real __filename/__dirname are provided instead); tsx runs it as real ESM,
// where __filename/__dirname don't exist. Support both.
const scriptFilename = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const scriptDirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(scriptFilename);

const app = express();
app.use(express.json());

// A pkg-packaged exe can be launched with process.cwd() pointing anywhere
// (double-click, shortcut with a different "start in" folder, etc.), which
// made applet_state.json/served_folder land in a different place on every
// launch and look like settings kept resetting. Always resolve them next to
// the actual executable file instead. In dev (tsx), process.cwd() is always
// the project root (npm run dev), so no change is needed there.
const isPackagedForPaths = !!(process as any).pkg;
const appBaseDir = isPackagedForPaths ? path.dirname(process.execPath) : process.cwd();
const STATE_FILE = path.join(appBaseDir, "applet_state.json");
const SETTINGS_FILE = path.join(appBaseDir, "setting.ini");
const SERVED_FOLDER = path.join(appBaseDir, "served_folder");

// Create served folder if it doesn't exist (clean, no dummy seed files)
if (!fs.existsSync(SERVED_FOLDER)) {
  fs.mkdirSync(SERVED_FOLDER, { recursive: true });
}

// Memory database state (completely clean, starting fresh)
let systemStatus: SystemStatus = {
  dhcpRunning: false,
  tftpRunning: false,
  ftpRunning: false,
  autoStart: true,
  cpuUsage: 0.0,
  memoryUsage: 0.0,
  uptime: 0
};

// Pick the host's first real (non-internal) IPv4 network adapter as the default
// binding target, instead of a fake preset name that never matches a real adapter.
function getDefaultInterfaceName(): string {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      const infos = nets[name];
      if (infos && infos.some(info => info.family === "IPv4" && !info.internal)) {
        return name;
      }
    }
  } catch (e) {
    console.error("Failed to enumerate network interfaces for default binding", e);
  }
  return "";
}

// Range/subnet mask are derived from the real adapter so they always describe
// a subnet this host is actually on. `gateway` is just a starting guess
// (the conventional ".1" of that subnet, like every other DHCP server
// defaults to) — it is handed to clients as-is via DHCP option 3 (router)
// and is NOT this server's own address. Do not default it to hostInfo.ip:
// this app has no IP-forwarding/NAT of its own, so a client using this
// machine's address as its gateway would be unable to reach anything beyond
// it. The server identifies itself to clients separately, by its own real
// interface IP (option 54/siaddr — see getInterfaceInfo/sendDhcpReply),
// independent of whatever gateway value is configured here.
function getSubnetDefaults(hostInfo: { ip: string; netmask: string }) {
  const parts = hostInfo.ip.split(".");
  const subnetBase = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return {
    rangeStart: `${subnetBase}.100`,
    rangeEnd: `${subnetBase}.200`,
    subnetMask: hostInfo.netmask || "255.255.255.0",
    gateway: `${subnetBase}.1`
  };
}

const initialInterfaceName = getDefaultInterfaceName();
const initialHostInfo = initialInterfaceName ? getInterfaceInfo(initialInterfaceName) : null;

let dhcpConfig: DhcpConfig = {
  interfaceName: initialInterfaceName,
  ...(initialHostInfo
    ? getSubnetDefaults(initialHostInfo)
    : { rangeStart: "192.168.1.100", rangeEnd: "192.168.1.200", subnetMask: "255.255.255.0", gateway: "192.168.1.1" }),
  dns: "8.8.8.8",
  leaseTime: 120, // minutes
  serverIp: "", // empty = auto (use whatever real IP the adapter already has)
  extraRanges: []
};

let leases: DhcpLease[] = [];
let reservations: DhcpReservation[] = [];

let tftpFtpConfig: TftpFtpConfig = {
  tftpEnabled: false,
  ftpEnabled: false,
  rootFolder: SERVED_FOLDER,
  tftpPort: 69,
  ftpPort: 21
};

// Whitelisted FTP logins (see the real FTP server section below) — empty by
// default, meaning FTP rejects every login until at least one is added.
let ftpCredentials: FtpCredential[] = [];

// Web dashboard login (see the AUTH section below). This app binds to
// 0.0.0.0, so its dashboard — DHCP config, TFTP/FTP folder, SSH/Telnet
// device credentials, everything — is reachable by anyone on the LAN
// unless gated behind a login. `null` means no account has been created
// yet; the frontend must show a one-time "create admin account" screen
// (POST /api/auth/setup) before anything else in that state, since there
// is deliberately no way to reach any other API without an account existing
// and a valid session (see requireAuth below).
interface WebAuthConfig {
  username: string;
  passwordHash: string;
  passwordSalt: string;
}
let webAuth: WebAuthConfig | null = null;

let transferLogs: TransferLog[] = [];
let terminalHosts: TerminalHost[] = [];
let commandScripts: CommandScript[] = [];
let scriptExecutions: ScriptExecution[] = [];
// Saved "device list + script" combinations for one-click batch re-runs
// (see POST /api/batch-jobs / DELETE /api/batch-jobs/:id below). Execution
// itself has no backend representation — the frontend just replays the
// existing per-host /api/scripts/execute fan-out.
let batchJobs: BatchJob[] = [];

// Clean standard boot log
let dhcpConsoleLogs: { timestamp: string; level: 'INFO' | 'SUCCESS' | 'WARN'; message: string }[] = [
  { timestamp: new Date().toISOString(), level: 'INFO', message: 'DHCP service initialized.' }
];

// Minimal INI reader/writer — no external dependency. Sections hold flat
// key=value pairs; array/object config (terminalHosts, commandScripts, etc.)
// is stored as a single JSON-encoded string value within its own section, so
// it round-trips exactly while the simple scalar settings (DHCP pool, TFTP/FTP
// config) stay genuinely human-readable/editable in a text editor. This file
// is a secondary safety net alongside applet_state.json — see saveState/loadState.
function stringifyIni(sections: Record<string, Record<string, string>>): string {
  const lines: string[] = [];
  for (const [section, kv] of Object.entries(sections)) {
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(kv)) {
      // INI values are single-line — escape any embedded newlines so a JSON
      // blob (e.g. terminalHosts) can't corrupt the file structure.
      const safeValue = String(value).replace(/\r?\n/g, "\\n");
      lines.push(`${key}=${safeValue}`);
    }
    lines.push("");
  }
  return lines.join("\r\n");
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      result[currentSection] = result[currentSection] || {};
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1 || !currentSection) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).replace(/\\n/g, "\n");
    result[currentSection][key] = value;
  }
  return result;
}

// Load state from file (Fulfills system recovery and automatic starting configuration)
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.systemStatus) systemStatus = { ...systemStatus, ...data.systemStatus };
      if (data.dhcpConfig) dhcpConfig = { ...dhcpConfig, ...data.dhcpConfig };
      if (data.leases) {
        leases = data.leases;
        // Clean up any duplicate rows already sitting in a state file saved
        // before the discoverNetworkDevices() duplicate-spawning bug was
        // fixed, so upgrading and restarting clears them immediately instead
        // of waiting on the next natural save.
        dedupeLeases();
      }
      if (data.reservations) reservations = data.reservations;
      if (data.tftpFtpConfig) tftpFtpConfig = { ...tftpFtpConfig, ...data.tftpFtpConfig };
      if (data.ftpCredentials) ftpCredentials = data.ftpCredentials;
      if (data.webAuth) webAuth = data.webAuth;
      if (data.transferLogs) transferLogs = data.transferLogs;
      if (data.terminalHosts) terminalHosts = data.terminalHosts;
      if (data.commandScripts) commandScripts = data.commandScripts;
      if (data.batchJobs) batchJobs = data.batchJobs;
      if (data.dhcpConsoleLogs) dhcpConsoleLogs = data.dhcpConsoleLogs;

      console.log("State restored successfully. AutoStart checks initiating...");

      // Auto-start TFTP/FTP if configured to always run on boot — startServer()
      // below actually rebinds their real sockets to match these flags. DHCP is
      // deliberately excluded and always forced back to false here: it has a
      // real network-conflict risk (a second DHCP server answering on a LAN
      // that already has one), so it must never come back up silently on
      // launch — the previous version of this block set dhcpRunning = true
      // unconditionally and logged "Auto-started DHCP Server", which was
      // simply false (nothing ever binds the DHCP socket on boot — see
      // startServer()'s comment) and left the UI showing "가동중" every time
      // the app launched even though DHCP was never actually listening.
      if (systemStatus.autoStart) {
        systemStatus.tftpRunning = true;
        systemStatus.ftpRunning = true;
        tftpFtpConfig.tftpEnabled = true;
        tftpFtpConfig.ftpEnabled = true;
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'SUCCESS',
          message: 'System recovered from restart. Auto-started TFTP/FTP servers.'
        });
      }
      systemStatus.dhcpRunning = false;
    } else if (fs.existsSync(SETTINGS_FILE)) {
      // applet_state.json is missing (fresh install, moved exe without it, the
      // JSON write failed previously, etc.) but the human-readable setting.ini
      // safety net exists — restore as much as possible from it rather than
      // silently starting from a blank slate.
      try {
        const sections = parseIni(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        if (sections.DhcpConfig) {
          const s = sections.DhcpConfig;
          dhcpConfig = {
            ...dhcpConfig,
            ...(s.interfaceName && { interfaceName: s.interfaceName }),
            ...(s.rangeStart && { rangeStart: s.rangeStart }),
            ...(s.rangeEnd && { rangeEnd: s.rangeEnd }),
            ...(s.subnetMask && { subnetMask: s.subnetMask }),
            ...(s.gateway && { gateway: s.gateway }),
            ...(s.dns && { dns: s.dns }),
            ...(s.leaseTime && { leaseTime: Number(s.leaseTime) || dhcpConfig.leaseTime }),
            ...(s.serverIp !== undefined && { serverIp: s.serverIp }),
            ...(s.extraRanges && { extraRanges: JSON.parse(s.extraRanges) })
          };
        }
        if (sections.TftpFtpConfig) {
          const s = sections.TftpFtpConfig;
          tftpFtpConfig = {
            ...tftpFtpConfig,
            ...(s.tftpEnabled !== undefined && { tftpEnabled: s.tftpEnabled === "true" }),
            ...(s.ftpEnabled !== undefined && { ftpEnabled: s.ftpEnabled === "true" }),
            ...(s.rootFolder && { rootFolder: s.rootFolder }),
            ...(s.tftpPort && { tftpPort: Number(s.tftpPort) || tftpFtpConfig.tftpPort }),
            ...(s.ftpPort && { ftpPort: Number(s.ftpPort) || tftpFtpConfig.ftpPort })
          };
        }
        if (sections.System?.autoStart !== undefined) {
          systemStatus.autoStart = sections.System.autoStart === "true";
        }
        if (sections.Reservations?.data) reservations = JSON.parse(sections.Reservations.data);
        if (sections.TerminalHosts?.data) terminalHosts = JSON.parse(sections.TerminalHosts.data);
        if (sections.CommandScripts?.data) commandScripts = JSON.parse(sections.CommandScripts.data);
        if (sections.BatchJobs?.data) batchJobs = JSON.parse(sections.BatchJobs.data);
        if (sections.FtpCredentials?.data) ftpCredentials = JSON.parse(sections.FtpCredentials.data);
        if (sections.WebAuth?.data) webAuth = JSON.parse(sections.WebAuth.data);

        console.log("State restored from setting.ini fallback (applet_state.json not found).");

        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'SUCCESS',
          message: `applet_state.json이 없어 설정 파일(${SETTINGS_FILE})에서 설정을 복원했습니다.`
        });

        // Auto-start TFTP/FTP if configured to always run on boot, same as the
        // applet_state.json restore path above. DHCP is deliberately excluded
        // and always forced back to false — see the comment on that path.
        if (systemStatus.autoStart) {
          systemStatus.tftpRunning = true;
          systemStatus.ftpRunning = true;
          tftpFtpConfig.tftpEnabled = true;
          tftpFtpConfig.ftpEnabled = true;
          dhcpConsoleLogs.push({
            timestamp: new Date().toISOString(),
            level: 'SUCCESS',
            message: 'System recovered from restart. Auto-started TFTP/FTP servers.'
          });
        }
        systemStatus.dhcpRunning = false;
      } catch (iniLoadError) {
        console.error("Failed to load setting.ini fallback", iniLoadError);
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `설정 파일(setting.ini) 복원에 실패했습니다: ${(iniLoadError as Error).message}. 경로: ${SETTINGS_FILE}`
        });
      }
    }
  } catch (error) {
    console.error("Failed to load state", error);
  }
}

// Save state to file
function saveState() {
  try {
    const data = {
      systemStatus,
      dhcpConfig,
      leases,
      reservations,
      tftpFtpConfig,
      ftpCredentials,
      webAuth,
      transferLogs,
      terminalHosts,
      commandScripts,
      batchJobs,
      dhcpConsoleLogs
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save state", error);
    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      message: `상태 파일(applet_state.json) 저장에 실패했습니다: ${(error as Error).message}. 경로: ${STATE_FILE}`
    });
  }

  // Secondary, independent safety net: also persist the settings as a
  // human-readable setting.ini next to the exe. This must not share a
  // try-catch with the JSON save above — either one failing (permissions,
  // encoding, disk issue, etc.) must not prevent the other from succeeding.
  try {
    const iniSections: Record<string, Record<string, string>> = {
      DhcpConfig: {
        interfaceName: dhcpConfig.interfaceName,
        rangeStart: dhcpConfig.rangeStart,
        rangeEnd: dhcpConfig.rangeEnd,
        subnetMask: dhcpConfig.subnetMask,
        gateway: dhcpConfig.gateway,
        dns: dhcpConfig.dns,
        leaseTime: String(dhcpConfig.leaseTime),
        serverIp: dhcpConfig.serverIp || "",
        extraRanges: JSON.stringify(dhcpConfig.extraRanges || [])
      },
      TftpFtpConfig: {
        tftpEnabled: String(tftpFtpConfig.tftpEnabled),
        ftpEnabled: String(tftpFtpConfig.ftpEnabled),
        rootFolder: tftpFtpConfig.rootFolder,
        tftpPort: String(tftpFtpConfig.tftpPort),
        ftpPort: String(tftpFtpConfig.ftpPort)
      },
      System: {
        autoStart: String(systemStatus.autoStart)
      },
      Reservations: { data: JSON.stringify(reservations) },
      TerminalHosts: { data: JSON.stringify(terminalHosts) },
      CommandScripts: { data: JSON.stringify(commandScripts) },
      BatchJobs: { data: JSON.stringify(batchJobs) },
      FtpCredentials: { data: JSON.stringify(ftpCredentials) },
      WebAuth: { data: JSON.stringify(webAuth) }
    };
    fs.writeFileSync(SETTINGS_FILE, stringifyIni(iniSections), "utf-8");
  } catch (iniError) {
    console.error("Failed to save setting.ini", iniError);
    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      message: `설정 파일(setting.ini) 저장에 실패했습니다: ${(iniError as Error).message}. 경로: ${SETTINGS_FILE}`
    });
  }
}

// Initial load
loadState();

// A persisted config may reference an adapter name from a previous run (or a
// different PC entirely) that doesn't exist on this host anymore. Self-heal by
// falling back to a real default adapter (with fresh subnet defaults) in that
// case. Returns true if the config was changed.
//
// NOTE: this does NOT compare dhcpConfig.gateway against the adapter's
// current IP — they are unrelated by design now (see getSubnetDefaults):
// `gateway` is just the router address handed to clients, independent of
// whatever real IP this host's adapter carries, so there is nothing to
// "heal" there even if they happen to differ.
function ensureDhcpConfigMatchesHost(): boolean {
  let healInterfaceName = dhcpConfig.interfaceName;
  let healHostInfo = getInterfaceInfo(healInterfaceName);
  const fellBackToDefaultInterface = !healHostInfo;
  if (!healHostInfo) {
    healInterfaceName = getDefaultInterfaceName();
    healHostInfo = healInterfaceName ? getInterfaceInfo(healInterfaceName) : null;
  }
  if (!healHostInfo) return false;

  const needsFreshDefaults = fellBackToDefaultInterface || !isValidIPv4(dhcpConfig.gateway);
  if (needsFreshDefaults) {
    dhcpConfig = {
      ...dhcpConfig,
      interfaceName: healInterfaceName,
      ...getSubnetDefaults(healHostInfo),
      // A configured serverIp only means something on the adapter it was set
      // for — if the adapter itself just changed (the old one is gone from
      // this host), that value is now stale/meaningless, so clear it back to
      // "auto" rather than carrying it over to an unrelated adapter. Same
      // reasoning for extraRanges: address chunks carved out of the old
      // adapter's subnet make no sense on a different one.
      ...(fellBackToDefaultInterface ? { serverIp: "", extraRanges: [] } : {})
    };
    return true;
  }
  return false;
}

ensureDhcpConfigMatchesHost();

/* ============================================================================
 * REAL DHCP SERVER ENGINE (RFC 2131 / RFC 2132) — DORA + RELEASE over UDP
 * ----------------------------------------------------------------------------
 * No maintained/trustworthy DHCP server npm package was found — the closest
 * candidate, `dhcp` on npm (github.com/infusion/node-dhcp), has not been
 * meaningfully updated since 2022, ships no TypeScript types, and (most
 * importantly for this app) offers no documented way to scope itself to a
 * single adapter. So this is a small, purpose-built implementation using
 * Node's `dgram` module directly, wired straight into the existing
 * `leases` / `reservations` / `dhcpConfig` state below.
 *
 * ADAPTER ISOLATION — READ THIS BEFORE TOUCHING THE BIND ADDRESS BELOW.
 * A DHCPDISCOVER is sent by a client to the broadcast address
 * (255.255.255.255:67) *before* it has an IP. On Windows (verified against
 * documented Winsock/BSD socket behavior), a UDP socket bound to one
 * specific unicast IP address will NOT receive packets addressed to a
 * broadcast destination — only a socket bound to 0.0.0.0 (INADDR_ANY) does.
 * That is not a Node.js limitation, it's how the OS delivers broadcast UDP
 * traffic to listening sockets, and it can't be worked around from `dgram`
 * without dropping to raw/packet-capture sockets (a native pcap-style
 * dependency, far outside this task's scope). Binding this socket to the
 * selected adapter's own IP instead of 0.0.0.0 would therefore make the
 * server permanently deaf to DHCPDISCOVER from brand-new devices — the
 * exact problem this real server exists to solve.
 *
 * So: the listening socket binds to 0.0.0.0:67 (required for DORA broadcast
 * to work at all), but isolation to the configured adapter is enforced in
 * software instead, on both sides:
 *   - SEND: every OFFER/ACK/NAK this server ever transmits is sent to the
 *     *subnet-directed* broadcast address of the selected adapter's own
 *     subnet (e.g. 10.0.5.255 for a 10.0.5.x/24 adapter) — never to the
 *     global 255.255.255.255. Standard IP routing can only deliver that
 *     packet out through the one NIC that owns a route to that subnet,
 *     which, by construction, is exclusively dhcpConfig.interfaceName
 *     (its range/mask are always derived from that adapter's own IP). This
 *     guarantees a DHCP reply from this app can never reach any network
 *     other than the one on the selected adapter, regardless of what the
 *     listening socket happened to receive.
 *   - RECEIVE: any inbound packet that carries a real (non-zero) source IP
 *     — i.e. everything except a fresh DISCOVER, which has no IP yet — is
 *     dropped unless that source IP actually belongs to the configured
 *     adapter's subnet. Fresh DISCOVERs can't be filtered this way (no
 *     source IP to check), but since this server only ever hands out
 *     addresses from dhcpConfig.rangeStart–rangeEnd (itself scoped to the
 *     selected adapter's subnet) and only ever replies via that subnet's
 *     broadcast address, an errant DISCOVER arriving from an unrelated
 *     adapter simply never gets a reply it could use.
 * ==========================================================================*/

let dhcpSocket: dgram.Socket | null = null;
let dhcpConflictWarningLogged = false;

function logDhcp(level: 'INFO' | 'SUCCESS' | 'WARN', message: string) {
  dhcpConsoleLogs.push({ timestamp: new Date().toISOString(), level, message });
  // Keep the persisted console log from growing without bound under real traffic.
  if (dhcpConsoleLogs.length > 500) {
    dhcpConsoleLogs.splice(0, dhcpConsoleLogs.length - 500);
  }
}

function ipToInt(ip: string): number {
  const p = ip.split(".").map(n => parseInt(n, 10) || 0);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function computeBroadcastAddress(ip: string, mask: string): string {
  const ipInt = ipToInt(ip);
  const maskInt = ipToInt(mask);
  return intToIp(((ipInt & maskInt) >>> 0 | (~maskInt >>> 0)) >>> 0);
}

function computeNetworkAddress(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

function isIpInSubnet(ip: string, subnetIp: string, mask: string): boolean {
  return computeNetworkAddress(ip, mask) === computeNetworkAddress(subnetIp, mask);
}

// --- Raw DHCP packet parsing/building (RFC 2131 BOOTP header + RFC 2132 options) ---

interface ParsedDhcpPacket {
  op: number;
  xid: number;
  flags: number;
  ciaddr: string;
  chaddr: string; // "AA:BB:CC:DD:EE:FF"
  options: Map<number, Buffer>;
}

const DHCP_MAGIC_COOKIE = 0x63825363;

function parseDhcpPacket(buf: Buffer): ParsedDhcpPacket | null {
  if (buf.length < 240) return null;
  if (buf.readUInt32BE(236) !== DHCP_MAGIC_COOKIE) return null;

  const op = buf.readUInt8(0);
  const hlen = buf.readUInt8(2);
  const xid = buf.readUInt32BE(4);
  const flags = buf.readUInt16BE(10);
  const ciaddr = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
  const macLen = Math.min(hlen || 6, 16);
  const chaddr = Array.from(buf.subarray(28, 28 + macLen))
    .map(b => b.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();

  const options = new Map<number, Buffer>();
  let i = 240;
  while (i < buf.length) {
    const tag = buf.readUInt8(i);
    if (tag === 0xff) break; // End option
    if (tag === 0x00) { i += 1; continue; } // Pad option
    if (i + 1 >= buf.length) break;
    const len = buf.readUInt8(i + 1);
    if (i + 2 + len > buf.length) break;
    options.set(tag, Buffer.from(buf.subarray(i + 2, i + 2 + len)));
    i += 2 + len;
  }

  return { op, xid, flags, ciaddr, chaddr, options };
}

function writeOption(buf: Buffer, offset: number, tag: number, value: Buffer): number {
  buf.writeUInt8(tag, offset);
  buf.writeUInt8(value.length, offset + 1);
  value.copy(buf, offset + 2);
  return offset + 2 + value.length;
}

function ipOption(ip: string): Buffer {
  return Buffer.from(ip.split(".").map(n => parseInt(n, 10) & 0xff));
}

function uint32Option(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// messageType: 2 = DHCPOFFER, 5 = DHCPACK, 6 = DHCPNAK
function buildDhcpReply(opts: {
  messageType: number;
  xid: number;
  flags: number;
  yiaddr: string;
  chaddr: string;
  serverIp: string;
  subnetMask: string;
  router: string;
  dns: string;
  leaseSeconds: number;
}): Buffer {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(2, 0); // op = BOOTREPLY
  buf.writeUInt8(1, 1); // htype = Ethernet
  buf.writeUInt8(6, 2); // hlen
  buf.writeUInt8(0, 3); // hops
  buf.writeUInt32BE(opts.xid >>> 0, 4);
  buf.writeUInt16BE(0, 8); // secs
  buf.writeUInt16BE(opts.flags, 10); // echo back the client's broadcast flag

  if (opts.messageType !== 6) {
    ipOption(opts.yiaddr).copy(buf, 16); // yiaddr
  }
  ipOption(opts.serverIp).copy(buf, 20); // siaddr

  const macBytes = opts.chaddr.split(":").map(h => parseInt(h, 16) || 0);
  for (let i = 0; i < 6; i++) buf.writeUInt8(macBytes[i] || 0, 28 + i);

  buf.writeUInt32BE(DHCP_MAGIC_COOKIE, 236);

  let offset = 240;
  offset = writeOption(buf, offset, 53, Buffer.from([opts.messageType]));
  offset = writeOption(buf, offset, 54, ipOption(opts.serverIp));
  if (opts.messageType !== 6) {
    offset = writeOption(buf, offset, 51, uint32Option(opts.leaseSeconds));
    offset = writeOption(buf, offset, 1, ipOption(opts.subnetMask));
    if (opts.router) offset = writeOption(buf, offset, 3, ipOption(opts.router));
    if (opts.dns) offset = writeOption(buf, offset, 6, ipOption(opts.dns));
  }
  buf.writeUInt8(0xff, offset);
  offset += 1;

  return buf.subarray(0, offset);
}

function sendDhcpReply(messageType: number, pkt: ParsedDhcpPacket, offeredIp: string) {
  if (!dhcpSocket) return;
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
  if (!hostInfo) return;

  const buf = buildDhcpReply({
    messageType,
    xid: pkt.xid,
    flags: pkt.flags,
    yiaddr: offeredIp,
    chaddr: pkt.chaddr,
    serverIp: hostInfo.ip,
    subnetMask: dhcpConfig.subnetMask,
    router: dhcpConfig.gateway,
    dns: dhcpConfig.dns,
    leaseSeconds: dhcpConfig.leaseTime * 60
  });

  // See the isolation note above: always the *subnet-directed* broadcast of
  // the selected adapter's own subnet, never the global 255.255.255.255, so
  // the OS can only route this out through dhcpConfig.interfaceName.
  const broadcastAddr = computeBroadcastAddress(hostInfo.ip, dhcpConfig.subnetMask);
  dhcpSocket.send(buf, 0, buf.length, 68, broadcastAddr, (err) => {
    if (err) logDhcp('WARN', `DHCP 응답 패킷 전송 실패: ${err.message}`);
  });
}

// All configured address ranges as (start,end) int pairs — the primary
// rangeStart/rangeEnd plus any extraRanges (additional pool chunks, e.g. a
// /23 or /22 split into separate address blocks on the same subnet).
// Invalid entries (bad format, or start > end) are silently skipped rather
// than rejecting the whole pool.
function getAllDhcpRanges(): { start: number; end: number }[] {
  const raw = [{ start: dhcpConfig.rangeStart, end: dhcpConfig.rangeEnd }, ...(dhcpConfig.extraRanges || [])];
  const ranges: { start: number; end: number }[] = [];
  for (const r of raw) {
    const start = ipToInt(r.start);
    const end = ipToInt(r.end);
    if (!isValidIPv4(r.start) || !isValidIPv4(r.end) || start > end) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

function isIpInAnyDhcpRange(ip: string): boolean {
  const n = ipToInt(ip);
  return getAllDhcpRanges().some(r => n >= r.start && n <= r.end);
}

function findAvailableIp(): string | null {
  const usedIps = new Set(leases.filter(l => l.status !== 'expired').map(l => l.ip));
  const reservedIps = new Set(reservations.map(r => r.ip));
  for (const { start, end } of getAllDhcpRanges()) {
    for (let cur = start; cur <= end; cur++) {
      const candidate = intToIp(cur);
      if (!usedIps.has(candidate) && !reservedIps.has(candidate)) return candidate;
    }
  }
  return null;
}

// Add/update the single lease record for a MAC. This *is* the server's
// internal lease-tracking structure — there is no separate table — so
// deleting an entry from `leases` (e.g. via DELETE /api/dhcp/leases/:id)
// immediately makes that IP available again through findAvailableIp().
function upsertLease(mac: string, ip: string, hostname: string, status: 'active' | 'reserved'): DhcpLease {
  const now = Date.now();
  const idx = leases.findIndex(l => normalizeMac(l.mac) === mac && l.id !== 'host-pc-self');
  const record: DhcpLease = {
    id: idx >= 0 ? leases[idx].id : `lease-${now}-${mac.replace(/:/g, "")}`,
    ip,
    mac,
    hostname,
    interfaceName: dhcpConfig.interfaceName,
    leasedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + dhcpConfig.leaseTime * 60000).toISOString(),
    status
  };
  if (idx >= 0) leases[idx] = record; else leases.push(record);
  return record;
}

function handleDhcpDiscover(pkt: ParsedDhcpPacket) {
  const mac = pkt.chaddr;
  const reservation = reservations.find(r => normalizeMac(r.mac) === mac);
  let offerIp: string | undefined = reservation?.ip;
  if (!offerIp) {
    const existing = leases.find(l => normalizeMac(l.mac) === mac && l.status !== 'expired' && l.id !== 'host-pc-self');
    offerIp = existing?.ip || findAvailableIp() || undefined;
  }

  if (!offerIp) {
    logDhcp('WARN', `DHCPDISCOVER 수신 (MAC ${mac}) — 할당 가능한 IP가 없습니다 (주소 풀 소진: ${dhcpConfig.rangeStart} ~ ${dhcpConfig.rangeEnd}).`);
    return;
  }

  logDhcp('INFO', `DHCPDISCOVER 수신: MAC ${mac} → DHCPOFFER ${offerIp} 전송`);
  sendDhcpReply(2, pkt, offerIp);
}

function handleDhcpRequest(pkt: ParsedDhcpPacket) {
  const mac = pkt.chaddr;
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
  if (!hostInfo) return;

  const serverIdOpt = pkt.options.get(54);
  if (serverIdOpt && serverIdOpt.length === 4) {
    const serverId = Array.from(serverIdOpt).join(".");
    if (serverId !== hostInfo.ip) {
      // Client is confirming a lease offered by a *different* DHCP server
      // (e.g. the real router) — not this server's business, stay silent.
      return;
    }
  }

  const reqIpOpt = pkt.options.get(50);
  const requestedIp = reqIpOpt && reqIpOpt.length === 4
    ? Array.from(reqIpOpt).join(".")
    : (pkt.ciaddr !== "0.0.0.0" ? pkt.ciaddr : null);

  if (!requestedIp) {
    logDhcp('WARN', `DHCPREQUEST 수신 (MAC ${mac}) — 요청 IP를 확인할 수 없어 무시합니다.`);
    return;
  }

  const reservation = reservations.find(r => normalizeMac(r.mac) === mac);
  const isReservedForThisMac = !!reservation && reservation.ip === requestedIp;
  const inRange = isIpInAnyDhcpRange(requestedIp);
  const conflict = leases.find(l => l.ip === requestedIp && normalizeMac(l.mac) !== mac && l.status !== 'expired');

  if (conflict || (!inRange && !isReservedForThisMac)) {
    logDhcp('WARN', `DHCPREQUEST 거부: MAC ${mac} 가 요청한 IP ${requestedIp} 는 할당할 수 없어 DHCPNAK 전송`);
    sendDhcpReply(6, pkt, requestedIp);
    return;
  }

  // DHCP option 12 (Host Name) is optional from the client's perspective — some
  // devices send it on the very first DISCOVER/REQUEST but omit it on later
  // renewal REQUESTs. Previously an absent option 12 unconditionally overwrote
  // the lease with a generic "Device-X" name, permanently clobbering a real
  // hostname learned earlier. Now: fall back to the existing lease's hostname
  // (if any) before falling back to the generic name, so a real hostname
  // already on file survives renewals that don't resend option 12. A hostname
  // sent in *this* request (e.g. after the device rebooted with a new name)
  // still always wins.
  const hostnameOpt = pkt.options.get(12);
  const parsedHostname = hostnameOpt ? hostnameOpt.toString("utf8").replace(/[^\x20-\x7e]/g, "").trim() : "";
  const existingLease = leases.find(l => normalizeMac(l.mac) === mac && l.id !== 'host-pc-self');
  const hostname = parsedHostname || existingLease?.hostname || `Device-${requestedIp.split(".")[3]}`;

  upsertLease(mac, requestedIp, hostname, isReservedForThisMac ? 'reserved' : 'active');
  logDhcp('SUCCESS', `DHCPREQUEST 수신: MAC ${mac} → DHCPACK ${requestedIp} 전송 (${hostname}, ${dhcpConfig.leaseTime}분 임대)`);
  sendDhcpReply(5, pkt, requestedIp);
  saveState();
}

function handleDhcpRelease(pkt: ParsedDhcpPacket) {
  const mac = pkt.chaddr;
  // Fully drop the lease record (not just mark it expired) so the freed IP
  // is immediately available again and the released device leaves no stale
  // row behind in the assigned-device list. A 'reserved' (static) lease is
  // deliberately left alone — releasing doesn't undo a fixed reservation.
  const idx = leases.findIndex(l => normalizeMac(l.mac) === mac && l.id !== 'host-pc-self' && l.status !== 'reserved');
  if (idx >= 0) {
    const released = leases[idx];
    leases.splice(idx, 1);
    logDhcp('INFO', `DHCPRELEASE 수신: MAC ${mac} 가 IP ${released.ip} 를 반환했습니다. (주소 풀로 회수됨)`);
    saveState();
  }
}

// Called by the background ticker: mark expired dynamic leases as 'expired'
// (freeing their IP for reassignment via findAvailableIp) and eventually
// drop very old expired entries so the array doesn't grow forever.
function expireLeases() {
  const now = Date.now();
  let changed = false;
  for (const lease of leases) {
    if (lease.status === 'active' && new Date(lease.expiresAt).getTime() <= now) {
      lease.status = 'expired';
      changed = true;
      logDhcp('INFO', `임대 만료: IP ${lease.ip} (MAC ${lease.mac}, ${lease.hostname}) 가 만료되어 회수되었습니다.`);
    }
  }
  const beforeCount = leases.length;
  leases = leases.filter(l => l.status !== 'expired' || now - new Date(l.expiresAt).getTime() < 10 * 60 * 1000);
  if (changed || leases.length !== beforeCount) saveState();
}

// Collapses lease rows that share the same normalized (MAC, IP) pair down to
// a single entry. The root cause of duplicates was discoverNetworkDevices()
// respawning a fresh "Device-X" row every time an ARP-only-tracked device's
// pseudo-lease expired (fixed above), but this also self-heals any
// duplicates already sitting in persisted state from before that fix, and
// is a backstop against any other path that might ever create one. Two
// entries with the same IP but a *different* MAC are left alone — that's a
// real conflict/anomaly worth surfacing, not a duplicate to hide.
function dedupeLeases(): boolean {
  const bestByKey = new Map<string, DhcpLease>();
  const isGenericHostname = (l: DhcpLease) => /^Device-\d+$/.test(l.hostname);
  const statusRank = (l: DhcpLease) => l.status === 'reserved' ? 2 : l.status === 'active' ? 1 : 0;

  for (const lease of leases) {
    if (lease.id === 'host-pc-self') continue;
    const key = `${normalizeMac(lease.mac)}|${lease.ip}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, lease);
      continue;
    }
    // Prefer (in order): reserved > active > expired, then a real hostname
    // over a generic "Device-N" one, then whichever was leased more recently.
    let winner = existing;
    if (statusRank(lease) !== statusRank(existing)) {
      winner = statusRank(lease) > statusRank(existing) ? lease : existing;
    } else if (isGenericHostname(existing) !== isGenericHostname(lease)) {
      winner = isGenericHostname(existing) ? lease : existing;
    } else if (new Date(lease.leasedAt).getTime() > new Date(existing.leasedAt).getTime()) {
      winner = lease;
    }
    bestByKey.set(key, winner);
  }

  const beforeCount = leases.length;
  const keepIds = new Set(Array.from(bestByKey.values()).map(l => l.id));
  leases = leases.filter(l => l.id === 'host-pc-self' || keepIds.has(l.id));
  const removed = beforeCount - leases.length;
  if (removed > 0) {
    logDhcp('INFO', `중복된 임대 항목 ${removed}건을 정리했습니다.`);
    return true;
  }
  return false;
}

function describeSocketBindError(err: NodeJS.ErrnoException): string {
  if (err.code === "EACCES") {
    return "DHCP 서버 포트(67) 바인딩 실패 — 관리자 권한으로 실행하거나 다른 DHCP 서버와의 포트 충돌을 확인하세요. (권한 부족: EACCES)";
  }
  if (err.code === "EADDRINUSE") {
    return "DHCP 서버 포트(67) 바인딩 실패 — 이미 다른 프로그램(다른 DHCP 서버 등)이 포트 67을 사용 중입니다. (EADDRINUSE)";
  }
  return `DHCP 서버 포트(67) 바인딩 실패: ${err.message}`;
}

function startDhcpServer(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (dhcpSocket) {
      resolve({ success: true });
      return;
    }

    const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
    if (!hostInfo) {
      resolve({ success: false, error: `인터페이스 [${dhcpConfig.interfaceName}]를 이 호스트에서 찾을 수 없습니다.` });
      return;
    }

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) {
        // Runtime error after a successful start — log but don't tear down
        // the promise (it already resolved).
        logDhcp('WARN', `DHCP 서버 소켓 오류: ${err.message}`);
        return;
      }
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve({ success: false, error: describeSocketBindError(err) });
    });

    socket.on("message", (msg, rinfo) => {
      try {
        const pkt = parseDhcpPacket(msg);
        if (!pkt || pkt.op !== 1) return; // BOOTREQUEST only

        // Defense in depth (see the isolation note above): drop any packet
        // whose real source IP doesn't belong to the configured adapter's
        // subnet. Fresh DHCPDISCOVER has source 0.0.0.0 and can't be
        // filtered this way — that's covered by confining every reply to
        // the configured subnet's broadcast address instead.
        if (rinfo.address !== "0.0.0.0") {
          const currentHost = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
          if (currentHost && !isIpInSubnet(rinfo.address, currentHost.ip, dhcpConfig.subnetMask)) {
            return;
          }
        }

        const type = pkt.options.get(53)?.[0];
        if (type === 1) handleDhcpDiscover(pkt);
        else if (type === 3) handleDhcpRequest(pkt);
        else if (type === 7) handleDhcpRelease(pkt);
      } catch (e) {
        console.error("DHCP 패킷 처리 중 오류", e);
      }
    });

    // Must bind 0.0.0.0 to receive broadcast DHCPDISCOVER at all (see the
    // isolation note above) — single-adapter scoping is enforced on the
    // send side and via the subnet source-IP filter above instead.
    socket.bind(67, "0.0.0.0", () => {
      if (settled) return;
      settled = true;
      try { socket.setBroadcast(true); } catch { /* best effort */ }
      dhcpSocket = socket;
      resolve({ success: true });
    });
  });
}

function stopDhcpServer() {
  if (dhcpSocket) {
    try { dhcpSocket.close(); } catch { /* already closed */ }
    dhcpSocket = null;
  }
}

// Ticker to update uptime and process utilization metrics
let tickCount = 0;
setInterval(() => {
  tickCount++;

  // Update uptime
  systemStatus.uptime += 2;

  // Reclaim expired dynamic leases so their IPs become available again, and
  // collapse any duplicate rows a still-in-progress scan cycle might have
  // left behind (see dedupeLeases() — mainly a backstop now that the actual
  // duplicate-spawning bug in discoverNetworkDevices() is fixed).
  if (systemStatus.dhcpRunning) {
    expireLeases();
    if (dedupeLeases()) saveState();
  }

  // Periodically (every ~4s) scan the LAN for real devices while DHCP is running.
  if (tickCount % 2 === 0 && systemStatus.dhcpRunning) {
    discoverNetworkDevices().catch(e => console.error("Network device discovery failed", e));
  }

  // Periodically (every ~6s) ping-sweep known leases to refresh online/offline status.
  if (tickCount % 3 === 0 && systemStatus.dhcpRunning) {
    pingSweepLeases().catch(e => console.error("Lease ping sweep failed", e));
  }

  // Modulate CPU & memory for realistic visual feedback
  if (systemStatus.dhcpRunning || systemStatus.tftpRunning || systemStatus.ftpRunning) {
    const activeCount = (systemStatus.dhcpRunning ? 1 : 0) + (systemStatus.tftpRunning ? 1 : 0) + (systemStatus.ftpRunning ? 1 : 0);
    systemStatus.cpuUsage = parseFloat((0.5 + activeCount * 0.4 + Math.random() * 0.5).toFixed(1));
    systemStatus.memoryUsage = parseFloat((25.2 + activeCount * 0.8 + Math.random() * 0.2).toFixed(1));
  } else {
    systemStatus.cpuUsage = parseFloat((0.1 + Math.random() * 0.2).toFixed(1));
    systemStatus.memoryUsage = parseFloat((24.0 + Math.random() * 0.1).toFixed(1));
  }

  // Handle in-progress transfer logs (simulate transferring files)
  let updatedTransfers = false;
  transferLogs.forEach(log => {
    if (log.status === 'IN_PROGRESS') {
      updatedTransfers = true;
      log.progress += Math.floor(Math.random() * 20) + 5;
      if (log.progress >= 100) {
        log.progress = 100;
        log.status = 'COMPLETED';
        log.speed = '0 KB/s';
      } else {
        log.speed = (3.5 + Math.random() * 2).toFixed(1) + ' MB/s';
      }
    }
  });
  if (updatedTransfers) saveState();
}, 2000);


/* ============================================================================
 * WEB DASHBOARD LOGIN
 * ----------------------------------------------------------------------------
 * This app binds its HTTP server to 0.0.0.0 (see startServer() below), so the
 * dashboard is reachable by anyone on the LAN, not just this machine — and it
 * exposes real control over DHCP/TFTP/FTP and stored SSH/Telnet device
 * credentials. Every /api/* route except the four below is gated behind a
 * session cookie (see the app.use("/api", requireAuth) call further down).
 *
 * This is plain HTTP with no TLS anywhere in this app, so the session cookie
 * is not marked `secure` (it has to be sendable over http://) — it is not
 * designed to resist an active network eavesdropper, only to keep casual LAN
 * users out without a login. Passwords are never stored or logged in plain
 * text (scrypt + a random salt per account), unlike the FTP whitelist
 * credentials elsewhere in this file, which the user's own FTP protocol
 * requires to keep in a form the server can send back to `ftp-srv`.
 * ==========================================================================*/

const SESSION_COOKIE = "nss_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// In-memory only — a server restart naturally logs everyone out, which is
// normal session behavior and not worth persisting across restarts.
const webSessions = new Map<string, number>(); // token -> createdAt (ms)

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actualHash = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  // Constant-time comparison — a plain === would let an attacker measure
  // response time to guess the hash byte by byte.
  return actualHash.length === expected.length && crypto.timingSafeEqual(actualHash, expected);
}

// Express doesn't parse incoming cookies without the `cookie-parser` package
// (res.cookie()/res.clearCookie() for *sending* cookies are built in, but
// reading them back is not) — this avoids adding that dependency for what's
// otherwise a two-line parse of the raw `Cookie` header.
function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSessionToken(req: express.Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

function isSessionValid(token: string | undefined): boolean {
  if (!token) return false;
  const createdAt = webSessions.get(token);
  if (createdAt === undefined) return false;
  if (Date.now() - createdAt > SESSION_MAX_AGE_MS) {
    webSessions.delete(token);
    return false;
  }
  return true;
}

function startSession(res: express.Response): void {
  const token = crypto.randomBytes(32).toString("hex");
  webSessions.set(token, Date.now());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/"
  });
}

// Public — must work with no account and no session yet, since they're how
// the frontend decides whether to show "create admin account", "log in", or
// the real dashboard.
app.get("/api/auth/status", (req, res) => {
  res.json({
    configured: !!webAuth,
    authenticated: isSessionValid(getSessionToken(req)),
    username: webAuth?.username
  });
});

// Only allowed once — this is how the very first admin account gets created,
// not a general-purpose "add another user" route (this app has exactly one
// account by design, matching its single-operator local-appliance model).
app.post("/api/auth/setup", (req, res) => {
  if (webAuth) {
    return res.status(400).json({ error: "이미 계정이 설정되어 있습니다." });
  }
  const { username, password } = req.body;
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || password.length < 4) {
    return res.status(400).json({ error: "아이디와 4자 이상의 비밀번호를 입력하세요." });
  }
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  webAuth = { username: username.trim(), passwordHash: hashPassword(password, passwordSalt), passwordSalt };
  saveState();
  startSession(res);
  res.json({ success: true, username: webAuth.username });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!webAuth || typeof username !== "string" || typeof password !== "string" ||
      username.trim() !== webAuth.username || !verifyPassword(password, webAuth.passwordSalt, webAuth.passwordHash)) {
    return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  }
  startSession(res);
  res.json({ success: true, username: webAuth.username });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getSessionToken(req);
  if (token) webSessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// Everything below this line under /api requires a valid session. Routes
// registered *above* this point (the four auth routes just defined) already
// finished handling their own request before Express ever reaches this
// middleware, so they stay reachable without a session — this line does not
// need to (and must not) special-case their paths.
app.use("/api", (req, res, next) => {
  if (!webAuth) {
    return res.status(401).json({ error: "AUTH_NOT_CONFIGURED" });
  }
  if (!isSessionValid(getSessionToken(req))) {
    return res.status(401).json({ error: "AUTH_REQUIRED" });
  }
  next();
});

app.post("/api/auth/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!webAuth) return res.status(400).json({ error: "설정된 계정이 없습니다." });
  if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, webAuth.passwordSalt, webAuth.passwordHash)) {
    return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
  }
  if (typeof newPassword !== "string" || newPassword.length < 4) {
    return res.status(400).json({ error: "새 비밀번호는 4자 이상이어야 합니다." });
  }
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  webAuth = { ...webAuth, passwordHash: hashPassword(newPassword, passwordSalt), passwordSalt };
  saveState();
  res.json({ success: true });
});

/* --- SYSTEM API ENDPOINTS --- */

app.get("/api/status", (req, res) => {
  res.json({
    systemStatus,
    dhcpConfig,
    dhcpServerIp: getCurrentDhcpServerIp(),
    leases,
    reservations,
    tftpFtpConfig,
    ftpCredentials,
    transferLogs,
    terminalHosts,
    commandScripts,
    batchJobs,
    dhcpConsoleLogs
  });
});

app.post("/api/system/console-log/clear", (req, res) => {
  dhcpConsoleLogs = [];
  saveState();
  res.json({ success: true, dhcpConsoleLogs });
});

// Helper to extract IP and MAC from selected interface name. An adapter can
// carry more than one IPv4 address at once (its own DHCP/APIPA-assigned
// primary, plus a secondary "server IP" alias this app may have added — see
// ensureServerIpOnAdapter below). When `preferredIp` is given and present
// among this adapter's addresses, it's returned instead of just "whichever
// the OS lists first" — the DHCP engine passes dhcpConfig.serverIp here so
// it consistently identifies itself by the admin's configured address once
// that alias exists, regardless of what the adapter's primary address is.
// Returns null when the adapter can't be found on this host — callers must
// handle that explicitly instead of silently falling back to fabricated data.
function getInterfaceInfo(name: string, preferredIp?: string): { ip: string; mac: string; netmask: string } | null {
  try {
    const nets = os.networkInterfaces();
    const infos = nets[name];
    if (infos) {
      const ipv4s = infos.filter(info => info.family === "IPv4" && !info.internal);
      let chosen = preferredIp ? ipv4s.find(info => info.address === preferredIp) : undefined;
      if (!chosen) chosen = ipv4s[0];
      if (!chosen) chosen = infos.find(info => info.family === "IPv4");
      if (chosen) {
        return {
          ip: chosen.address,
          mac: chosen.mac || "00:00:00:00:00:00",
          netmask: chosen.netmask
        };
      }
    }
  } catch (e) {
    console.error("Error reading interface details", e);
  }
  return null;
}

// The DHCP server's own identifying IP as far as clients are concerned (DHCP
// option 54/siaddr). If dhcpConfig.serverIp is set AND currently present on
// the bound adapter (as its primary address or as an alias this app added —
// see ensureServerIpOnAdapter), that's what's returned; otherwise falls back
// to whatever real IP the adapter naturally has. Computed fresh on every
// call rather than cached, so it can never drift out of sync with reality.
// Exposed to the frontend as the "서버 IP" badge, distinct from the
// separately-configurable `dhcpConfig.gateway` clients are told to route
// through.
function getCurrentDhcpServerIp(): string {
  return getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp)?.ip || "";
}

function isValidIPv4(ip: string): boolean {
  if (!ip) return false;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// Every MAC coming off the wire (DHCPDISCOVER/REQUEST/RELEASE chaddr, arp -a)
// is already normalized to this exact "AA:BB:CC:DD:EE:FF" uppercase form —
// but a MAC typed by hand into the reservation form (or a CSV bulk import)
// can be any case/separator the user happened to type. Comparing those two
// case-sensitively (`===`) was the actual bug behind reservations leaving a
// duplicate/orphaned lease entry behind: `"aa:bb:..." !== "AA:BB:..."`, so
// the old dynamic lease for that MAC never got cleaned up when the
// reservation replaced it, and a real DHCPRELEASE for that MAC later never
// matched it either. Use this for every reservation/lease MAC comparison —
// both to normalize new input at the door and, defensively, to compare
// existing values that may predate this fix.
function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase().replace(/-/g, ":");
}

function isValidMac(mac: string): boolean {
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(normalizeMac(mac));
}

// Runs a PowerShell script via -EncodedCommand (Base64 UTF-16LE), so
// interface names / IPs containing quotes or other shell-special characters
// can never be misinterpreted or break out of the invocation — there's no
// shell parsing of the payload at all, unlike passing raw text as -Command.
//
// The preamble forces the console's OUTPUT encoding to UTF-8: Windows
// PowerShell 5.1 (unlike PowerShell 7) defaults the console output codepage
// to the system's legacy ANSI/OEM codepage (e.g. CP949 on Korean Windows)
// regardless of how the script itself was encoded, so any non-ASCII text a
// script writes via Write-Output (e.g. a Korean folder path picked in
// /api/tftpftp/browse-folder) comes back as mojibake once Node decodes the
// child process's stdout as UTF-8. Do not remove this — it's the fix for
// Korean text/paths not displaying correctly. $ProgressPreference is
// silenced too, since some cmdlets (New-Object, New-NetIPAddress, ...) emit
// a progress record to stderr that would otherwise show up as CLIXML noise.
function runPowerShellScript(script: string): Promise<{ success: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const preamble = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;\n";
    const encoded = Buffer.from(preamble + script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ success: !error, stdout: (stdout || "").trim(), stderr: (stderr || "").trim(), error: error?.message });
      }
    );
  });
}

// Defensive escaping for values embedded inside PowerShell single-quoted
// string literals: even though -EncodedCommand removes any shell-injection
// risk, a literal single quote in the value would still break out of the
// ' ... ' literal and corrupt the script, so double it per PowerShell's own
// quoting rules.
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

// All non-internal IPv4 addresses currently bound to an adapter (its primary
// plus any secondary aliases) — used to check whether the configured DHCP
// server IP is already present before trying to add it again.
function getAllInterfaceIPv4s(name: string): { ip: string; netmask: string }[] {
  const nets = os.networkInterfaces();
  const infos = nets[name];
  if (!infos) return [];
  return infos
    .filter(info => info.family === "IPv4" && !info.internal)
    .map(info => ({ ip: info.address, netmask: info.netmask }));
}

// Converts a dotted-decimal subnet mask (e.g. "255.255.255.0") into a CIDR
// prefix length (e.g. 24), as required by New-NetIPAddress -PrefixLength.
// Returns null if the mask isn't a well-formed IPv4 dotted-decimal value.
function subnetMaskToPrefixLength(mask: string): number | null {
  if (!isValidIPv4(mask)) return null;
  const octets = mask.split(".").map(Number);
  let value = 0;
  for (const o of octets) value = (value << 8) | o;
  // Force unsigned 32-bit interpretation (the top octet can push the shift
  // result negative in JS's 32-bit bitwise semantics).
  value = value >>> 0;
  let prefix = 0;
  for (let i = 31; i >= 0; i--) {
    if ((value & (1 << i)) !== 0) prefix++;
  }
  return prefix;
}

// Tracks the server-IP alias this process last added (if any), so switching
// dhcpConfig.serverIp to a different address can clean up the old alias
// instead of leaving it behind on the adapter forever.
let managedServerIpAlias: { interfaceName: string; ip: string } | null = null;

// Best-effort removal of a server-IP alias from an adapter. Tries the
// modern PowerShell NetTCPIP cmdlet first (Remove-NetIPAddress), falling back
// to the legacy netsh command if PowerShell fails for any reason. Never
// throws — if the IP is already gone (manually removed, adapter changed,
// etc.) both approaches just fail harmlessly and there's nothing useful to
// do with that here, so failures are merely logged.
async function removeServerIpAlias(interfaceName: string, ip: string): Promise<void> {
  const psScript = `Remove-NetIPAddress -IPAddress '${escapePowerShellSingleQuoted(ip)}' -Confirm:$false -ErrorAction Stop`;
  const psResult = await runPowerShellScript(psScript);
  if (psResult.success) {
    logDhcp("INFO", `DHCP 서버 IP 보조 주소(${ip}) 제거 성공 (PowerShell Remove-NetIPAddress, 어댑터: ${interfaceName}).`);
    return;
  }
  logDhcp("WARN", `DHCP 서버 IP 보조 주소(${ip}) 제거 - PowerShell 방식 실패 (어댑터: ${interfaceName}): ${psResult.stderr || psResult.error || "알 수 없는 오류"}. netsh 방식으로 재시도합니다.`);

  await new Promise<void>((resolve) => {
    execFile("netsh", ["interface", "ip", "delete", "address", `name=${interfaceName}`, `addr=${ip}`], (error, stdout, stderr) => {
      if (error) {
        logDhcp("WARN", `DHCP 서버 IP 보조 주소(${ip}) 제거 - netsh 방식도 실패 (어댑터: ${interfaceName}): ${(stderr && stderr.trim()) || error.message}. (이미 제거되어 있었을 수도 있습니다.)`);
      } else {
        logDhcp("INFO", `DHCP 서버 IP 보조 주소(${ip}) 제거 성공 (netsh 폴백, 어댑터: ${interfaceName}).`);
      }
      resolve();
    });
  });
}

// Make sure the configured adapter actually has the admin's chosen DHCP
// server IP available, WITHOUT ever touching whatever primary address it
// already has (DHCP-obtained, APIPA, or anything else). Rather than
// replacing the adapter's own "obtain automatically" address with a static
// one (fragile: Windows keeps fighting to renew/revert it, and every time
// this app is pointed at a different site/subnet the whole adapter has to be
// reconfigured), this adds the requested server IP as a *secondary* IP alias
// on the same adapter — never on any other adapter, so devices reachable
// only through other interfaces on this machine are completely unaffected.
// The adapter keeps whatever primary address it wants; the DHCP server
// identity simply also lives there.
//
// Two mechanisms are tried, in order:
//   1. PowerShell's New-NetIPAddress (NetTCPIP module, Windows 8/Server 2012+).
//      This is the modern, reliably-supported way to add a secondary static
//      IP on an adapter that's otherwise getting its primary address via
//      DHCP — the legacy netsh "interface ip add address" command is known to
//      fail or behave unpredictably in exactly that situation.
//   2. The legacy netsh command, kept as a fallback for hosts/environments
//      where PowerShell or the NetTCPIP module is unavailable.
// If both fail, the returned error string includes full diagnostic detail
// from both attempts plus a hint to check for administrator privileges.
async function ensureServerIpOnAdapter(interfaceName: string, serverIp: string, subnetMask: string): Promise<{ success: boolean; error?: string }> {
  if (!isValidIPv4(serverIp) || !isValidIPv4(subnetMask)) {
    return { success: false, error: "DHCP 서버 IP 또는 서브넷 마스크 형식이 올바르지 않습니다." };
  }

  const currentIps = getAllInterfaceIPv4s(interfaceName);
  if (currentIps.some(i => i.ip === serverIp)) {
    // Already present — either the admin set it manually, or we added it in a
    // previous cycle. Nothing to do.
    managedServerIpAlias = { interfaceName, ip: serverIp };
    return { success: true };
  }

  logDhcp("INFO", `DHCP 서버 IP 보조 주소(${serverIp}/${subnetMask}) 추가 시도 - 어댑터 '${interfaceName}'에 현재 잡혀있는 IPv4 주소: ${currentIps.length > 0 ? currentIps.map(i => `${i.ip} (mask ${i.netmask})`).join(", ") : "(없음)"}`);

  // If we previously added an alias for a *different* address on this same
  // adapter (the admin changed the configured server IP), remove it first so
  // aliases don't pile up indefinitely across repeated reconfigurations.
  if (managedServerIpAlias && managedServerIpAlias.interfaceName === interfaceName && managedServerIpAlias.ip !== serverIp) {
    await removeServerIpAlias(interfaceName, managedServerIpAlias.ip);
  }

  const prefixLength = subnetMaskToPrefixLength(subnetMask);
  let psFailureDetail = "";
  if (prefixLength === null) {
    psFailureDetail = `서브넷 마스크(${subnetMask})를 CIDR prefix length로 변환할 수 없습니다.`;
    logDhcp("WARN", `DHCP 서버 IP 보조 주소 추가 - PowerShell 방식 건너뜀 (어댑터: ${interfaceName}): ${psFailureDetail}`);
  } else {
    const psScript = `New-NetIPAddress -InterfaceAlias '${escapePowerShellSingleQuoted(interfaceName)}' -IPAddress '${escapePowerShellSingleQuoted(serverIp)}' -PrefixLength ${prefixLength} -ErrorAction Stop | Out-Null`;
    const psResult = await runPowerShellScript(psScript);
    if (psResult.success) {
      managedServerIpAlias = { interfaceName, ip: serverIp };
      logDhcp("SUCCESS", `PowerShell(New-NetIPAddress) 방식으로 DHCP 서버 IP 보조 주소(${serverIp}/${prefixLength}) 추가 성공 (어댑터: ${interfaceName}).`);
      return { success: true };
    }
    psFailureDetail = psResult.stderr || psResult.error || "알 수 없는 오류";
    logDhcp("WARN", `DHCP 서버 IP 보조 주소 추가 - PowerShell(New-NetIPAddress) 방식 실패 (어댑터: ${interfaceName}): ${psFailureDetail}. netsh 방식으로 재시도합니다.`);
  }

  return new Promise((resolve) => {
    // execFile (no shell) — args are passed straight to the process, never
    // interpreted for shell metacharacters, so a malformed or hostile
    // subnetMask/interfaceName value can't break out into arbitrary command
    // execution.
    execFile(
      "netsh",
      ["interface", "ip", "add", "address", `name=${interfaceName}`, `addr=${serverIp}`, `mask=${subnetMask}`],
      (error, stdout, stderr) => {
        if (error) {
          const netshFailureDetail = (stderr && stderr.trim()) || error.message;
          const combinedError = `PowerShell 방식 실패: ${psFailureDetail}. netsh 방식도 실패: ${netshFailureDetail}. 관리자 권한으로 실행 중인지 확인하세요.`;
          logDhcp("WARN", `DHCP 서버 IP 보조 주소 추가 - netsh 방식도 실패 (어댑터: ${interfaceName}): ${netshFailureDetail}`);
          resolve({ success: false, error: combinedError });
        } else {
          managedServerIpAlias = { interfaceName, ip: serverIp };
          logDhcp("SUCCESS", `netsh(폴백) 방식으로 DHCP 서버 IP 보조 주소(${serverIp}) 추가 성공 (어댑터: ${interfaceName}).`);
          resolve({ success: true });
        }
      }
    );
  });
}

// Endpoint to fetch physical local network interfaces from host PC
app.get("/api/interfaces", (req, res) => {
  try {
    const nets = os.networkInterfaces();
    const list: any[] = [];
    for (const name of Object.keys(nets)) {
      const infos = nets[name];
      if (infos) {
        // Only expose adapters with a real, non-internal IPv4 address — DHCP can't
        // meaningfully bind to loopback/internal-only interfaces.
        const ipv4 = infos.find(info => info.family === "IPv4" && !info.internal);
        if (ipv4) {
          list.push({
            name,
            ip: ipv4.address,
            mac: ipv4.mac || "00:11:22:33:44:55",
            netmask: ipv4.netmask,
            internal: ipv4.internal
          });
        }
      }
    }
    res.json({ interfaces: list });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DHCP Service Controls
app.post("/api/dhcp/toggle", async (req, res) => {
  const { enabled } = req.body;

  if (enabled) {
    // Make sure the gateway/range being handed out reflects this host's *current*
    // real interface IP the moment the service actually starts, in case it drifted
    // since boot (e.g. this PC's own IP was renewed by the real router's DHCP).
    ensureDhcpConfigMatchesHost();
    let hostInfo = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);

    if (!hostInfo) {
      systemStatus.dhcpRunning = false;
      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: `Interface [${dhcpConfig.interfaceName}] was not found on this host. Select a valid adapter before starting the DHCP service.`
      });
      saveState();
      return res.json({
        success: false,
        error: `인터페이스 [${dhcpConfig.interfaceName}]를 찾을 수 없습니다. 유효한 어댑터를 먼저 선택하세요.`,
        systemStatus, dhcpConfig, dhcpServerIp: getCurrentDhcpServerIp(), leases, dhcpConsoleLogs
      });
    }

    // If the admin configured a specific DHCP server IP, make sure the
    // adapter actually has it — as a secondary alias, never by touching the
    // adapter's own primary address (see ensureServerIpOnAdapter for why).
    // An empty serverIp means "auto" (just use whatever the adapter already
    // has), so nothing to do in that case.
    if (dhcpConfig.serverIp && hostInfo.ip !== dhcpConfig.serverIp) {
      const aliasResult = await ensureServerIpOnAdapter(dhcpConfig.interfaceName, dhcpConfig.serverIp, dhcpConfig.subnetMask);
      if (!aliasResult.success) {
        systemStatus.dhcpRunning = false;
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `어댑터에 DHCP 서버 IP(${dhcpConfig.serverIp})를 추가하지 못했습니다: ${aliasResult.error || '알 수 없는 오류'} (관리자 권한으로 실행 중인지 확인하세요)`
        });
        saveState();
        return res.json({
          success: false,
          error: `어댑터에 DHCP 서버 IP를 추가하지 못했습니다: ${aliasResult.error || '알 수 없는 오류'}`,
          systemStatus, dhcpConfig, dhcpServerIp: getCurrentDhcpServerIp(), leases, dhcpConsoleLogs
        });
      }

      const refreshed = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
      if (refreshed) hostInfo = refreshed;

      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'SUCCESS',
        message: `[자동 조치] 어댑터에 DHCP 서버 IP(${dhcpConfig.serverIp}/${dhcpConfig.subnetMask})를 보조 주소로 추가했습니다. 어댑터의 기존 기본 IP 설정(자동/DHCP 등)은 변경하지 않았습니다.`
      });
    } else if (!dhcpConfig.serverIp && managedServerIpAlias && managedServerIpAlias.interfaceName === dhcpConfig.interfaceName) {
      // The admin cleared the server IP back to "auto" after previously
      // setting one — remove the now-unwanted alias instead of leaving it on
      // the adapter forever.
      await removeServerIpAlias(dhcpConfig.interfaceName, managedServerIpAlias.ip);
      managedServerIpAlias = null;
      const refreshed = getInterfaceInfo(dhcpConfig.interfaceName);
      if (refreshed) hostInfo = refreshed;
    }

    // Actually bind the real DHCP socket (port 67). This can fail on
    // Windows without admin rights (EACCES) or if another DHCP
    // server/service already owns the port (EADDRINUSE) — either way we
    // must not crash, and must revert dhcpRunning back to false so the
    // frontend accurately reflects that the service did NOT start.
    const startResult = await startDhcpServer();
    if (!startResult.success) {
      systemStatus.dhcpRunning = false;
      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: startResult.error || 'DHCP 서버 소켓을 열지 못했습니다.'
      });
      saveState();
      return res.json({
        success: false,
        error: startResult.error,
        systemStatus, dhcpConfig, dhcpServerIp: getCurrentDhcpServerIp(), leases, dhcpConsoleLogs
      });
    }

    systemStatus.dhcpRunning = true;

    // One-time (per process lifetime) collision-risk warning the first time
    // the real DHCP server is actually started.
    if (!dhcpConflictWarningLogged) {
      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: '[경고] 실제 DHCP 서버가 시작되었습니다. 이 네트워크에 이미 다른 DHCP 서버(공유기 등)가 있다면 IP 충돌이 발생할 수 있습니다.'
      });
      dhcpConflictWarningLogged = true;
    }

    // Auto-register host PC itself to represent the static self-binding lease
    const hostLeaseIdx = leases.findIndex(l => l.id === "host-pc-self" || l.mac === hostInfo.mac);
    const hostLease: DhcpLease = {
      id: "host-pc-self",
      ip: hostInfo.ip,
      mac: hostInfo.mac,
      hostname: "LocalHost-PC (DHCP Server)",
      interfaceName: dhcpConfig.interfaceName,
      leasedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      status: "reserved"
    };

    if (hostLeaseIdx >= 0) {
      leases[hostLeaseIdx] = hostLease;
    } else {
      leases.unshift(hostLease);
    }

    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'SUCCESS',
      message: `DHCP Server started on interface: ${dhcpConfig.interfaceName} (UDP 67/68 바인딩 성공)`
    });

    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'SUCCESS',
      message: `[Local Bind] Host PC (${hostInfo.mac}) self-assigned IP: ${hostInfo.ip} for standard communication.`
    });
  } else {
    stopDhcpServer();
    systemStatus.dhcpRunning = false;
    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      message: 'DHCP Server stopped manually'
    });
  }

  saveState();
  res.json({ success: true, systemStatus, dhcpConfig, dhcpServerIp: getCurrentDhcpServerIp(), leases, dhcpConsoleLogs });
});

app.post("/api/dhcp/config", async (req, res) => {
  const newConfig: DhcpConfig = req.body;
  dhcpConfig = { ...dhcpConfig, ...newConfig };

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    message: `DHCP parameters updated. Range: ${dhcpConfig.rangeStart} - ${dhcpConfig.rangeEnd}`
  });

  if (systemStatus.dhcpRunning) {
    // The service is already running and the admin may have just pointed it
    // at a different adapter, or changed the configured server IP — make
    // sure the new server IP is present on the adapter immediately instead
    // of requiring a stop/start cycle. Changing `gateway` alone needs no
    // adapter action: it's just data handed to clients, not something this
    // host itself has to carry.
    let hostInfo = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);

    if (hostInfo && dhcpConfig.serverIp && hostInfo.ip !== dhcpConfig.serverIp) {
      const aliasResult = await ensureServerIpOnAdapter(dhcpConfig.interfaceName, dhcpConfig.serverIp, dhcpConfig.subnetMask);
      if (aliasResult.success) {
        const refreshed = getInterfaceInfo(dhcpConfig.interfaceName, dhcpConfig.serverIp);
        if (refreshed) hostInfo = refreshed;
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'SUCCESS',
          message: `[자동 조치] 어댑터에 새 DHCP 서버 IP(${dhcpConfig.serverIp}/${dhcpConfig.subnetMask})를 보조 주소로 추가했습니다.`
        });
      } else {
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `어댑터에 새 DHCP 서버 IP(${dhcpConfig.serverIp}) 보조 주소를 추가하지 못했습니다: ${aliasResult.error || '알 수 없는 오류'}`
        });
      }
    } else if (hostInfo && !dhcpConfig.serverIp && managedServerIpAlias && managedServerIpAlias.interfaceName === dhcpConfig.interfaceName) {
      // The admin cleared the server IP back to "auto" — remove the
      // now-unwanted alias instead of leaving it on the adapter forever.
      await removeServerIpAlias(dhcpConfig.interfaceName, managedServerIpAlias.ip);
      managedServerIpAlias = null;
      const refreshed = getInterfaceInfo(dhcpConfig.interfaceName);
      if (refreshed) hostInfo = refreshed;
    }

    if (hostInfo) {
      const hostLeaseIdx = leases.findIndex(l => l.id === "host-pc-self" || l.mac === hostInfo.mac);
      const hostLease: DhcpLease = {
        id: "host-pc-self",
        ip: hostInfo.ip,
        mac: hostInfo.mac,
        hostname: "LocalHost-PC (DHCP Server)",
        interfaceName: dhcpConfig.interfaceName,
        leasedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        status: "reserved"
      };
      if (hostLeaseIdx >= 0) {
        leases[hostLeaseIdx] = hostLease;
      } else {
        leases.unshift(hostLease);
      }
    } else {
      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        message: `Interface [${dhcpConfig.interfaceName}] was not found on this host.`
      });
    }
  }

  saveState();
  res.json({ success: true, dhcpConfig, dhcpServerIp: getCurrentDhcpServerIp(), leases, dhcpConsoleLogs });
});

// Parse the OS `arp -a` table to discover real devices currently visible on the LAN.
// This is not a real DHCP server (no DORA protocol handling) — it surfaces devices
// the host has actually exchanged traffic with recently, which is what a lightweight,
// network-safe "connected devices" view can offer without risking IP conflicts with
// whatever DHCP server already runs on the network.
function scanArpTable(): Promise<{ ip: string; mac: string }[]> {
  return new Promise((resolve) => {
    exec("arp -a", (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      const results: { ip: string; mac: string }[] = [];
      // The trailing "Type" column (dynamic/static) is never used below, so it's
      // matched loosely as \S+ rather than \w+ — on a Korean-localized Windows,
      // `arp -a` prints that column as Hangul (동적/정적), which JS's \w (ASCII-only
      // without a /u + \p{L} unicode flag) never matches, silently dropping every
      // line and making this always resolve to an empty table.
      const ipMacRegex = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})\s+(\S+)/;
      for (const line of stdout.split("\n")) {
        const match = line.match(ipMacRegex);
        if (!match) continue;
        const [, ip, macRaw] = match;
        if (ip.endsWith(".255") || ip.startsWith("224.") || ip.startsWith("239.")) continue;
        const mac = macRaw.replace(/-/g, ":").toUpperCase();
        if (mac === "FF:FF:FF:FF:FF:FF" || mac === "00:00:00:00:00:00") continue;
        results.push({ ip, mac });
      }
      resolve(results);
    });
  });
}

function reverseDnsLookup(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 800);
    dns.reverse(ip, (err, hostnames) => {
      clearTimeout(timer);
      resolve(!err && hostnames && hostnames.length > 0 ? hostnames[0] : null);
    });
  });
}

// Scan the LAN for devices actually reachable through the currently bound adapter and
// register any newly-seen ones as leases. Called periodically by the background ticker
// while the DHCP service is running, and can also be triggered on demand.
async function discoverNetworkDevices(): Promise<boolean> {
  if (!systemStatus.dhcpRunning) return false;
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
  if (!hostInfo) return false;

  // Was a string prefix match on the host IP's first 3 octets, which silently
  // assumed a /24 — a /23 or /22 pool spans multiple third octets, so real
  // devices sitting in the other half of the subnet were never discovered.
  // isIpInSubnet() compares against the actual configured mask instead.
  const found = await scanArpTable();
  const inSubnet = found.filter(d => isIpInSubnet(d.ip, hostInfo.ip, dhcpConfig.subnetMask) && d.ip !== hostInfo.ip);

  let changed = false;
  for (const device of inSubnet) {
    // A MAC already tracked in `leases` at all (whether issued by the real
    // DHCP server, a static reservation, or a previous ARP discovery) is
    // authoritative — the real DHCP server's own record for a device is
    // always more trustworthy than a possibly-stale ARP cache entry, so this
    // never overwrites its IP.
    //
    // IMPORTANT (bug fixed, don't reintroduce): this used to also require
    // `l.status !== 'expired'`. A device tracked only via ARP (no real DHCP
    // client ever renews it) has no way to keep its pseudo-lease from
    // expiring on schedule — expireLeases() marks it 'expired' the moment
    // `expiresAt` passes regardless of whether the device is still online.
    // With the old check, the very next ARP scan (every ~4s) no longer saw
    // that MAC as "already tracked" and pushed a brand-new lease for it —
    // repeating every ~leaseTime minutes forever, which is exactly why the
    // same physical device could pile up many "Device-X" duplicate rows
    // (all sharing one IP/MAC) over time. Now an expired-but-still-present
    // device is revived in place instead of duplicated.
    const existing = leases.find(l => normalizeMac(l.mac) === normalizeMac(device.mac));
    if (existing) {
      if (existing.status === 'expired') {
        existing.status = 'active';
        existing.leasedAt = new Date().toISOString();
        existing.expiresAt = new Date(Date.now() + dhcpConfig.leaseTime * 60000).toISOString();
        changed = true;
      }
      continue;
    }

    const hostname = (await reverseDnsLookup(device.ip)) || `Device-${device.ip.split(".")[3]}`;
    leases.push({
      id: "lease-" + Date.now() + "-" + device.mac.replace(/:/g, ""),
      ip: device.ip,
      mac: device.mac,
      hostname,
      interfaceName: dhcpConfig.interfaceName,
      leasedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + dhcpConfig.leaseTime * 60000).toISOString(),
      status: "active"
    });
    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'SUCCESS',
      message: `네트워크에서 새 단말 발견: ${hostname} (${device.mac}) - IP ${device.ip}`
    });
    changed = true;
  }

  if (changed) saveState();
  return changed;
}

// Ping every currently known lease's IP (including the host's own self-lease) to
// surface real-time online/offline status in the UI. All pings run concurrently
// via Promise.all — pinging sequentially would make this far too slow once there
// are more than a handful of leases.
async function pingSweepLeases(): Promise<void> {
  if (leases.length === 0) return;

  const results = await Promise.all(leases.map(lease => new Promise<{ id: string; online: boolean }>((resolve) => {
    // lease.ip can originate from an admin-entered reservation, not just the
    // server's own DHCP allocation logic — validate before it ever reaches a
    // shell command. execFile (no shell) is used regardless, as defense in depth.
    if (!isValidIPv4(lease.ip)) {
      resolve({ id: lease.id, online: false });
      return;
    }
    execFile("ping", ["-n", "1", "-w", "800", lease.ip], (error, stdout) => {
      const online = !error && /TTL=/i.test(stdout || "");
      resolve({ id: lease.id, online });
    });
  })));

  const now = new Date().toISOString();
  for (const result of results) {
    const lease = leases.find(l => l.id === result.id);
    if (!lease) continue;
    lease.online = result.online;
    lease.lastCheckedAt = now;
  }

  saveState();
}

// ARP-cache snapshot scoped to the currently bound adapter's subnet, tagged with
// whether each entry is already known to this DHCP server (as an issued lease or
// a static reservation) or not. The "unmanaged" ones are devices with a manually
// configured static IP that this DHCP server never issued and never will — the
// only way to see their IP otherwise is digging through `arp -a` by hand.
app.get("/api/dhcp/arp-table", async (req, res) => {
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
  if (!hostInfo) {
    return res.json({ entries: [] });
  }

  const subnetPrefix = hostInfo.ip.split(".").slice(0, 3).join(".") + ".";
  const found = await scanArpTable();
  const entries = found
    .filter(d => d.ip.startsWith(subnetPrefix))
    .map(d => {
      const reservation = reservations.find(r => normalizeMac(r.mac) === normalizeMac(d.mac));
      const lease = leases.find(l => normalizeMac(l.mac) === normalizeMac(d.mac));
      let matched: 'lease' | 'reservation' | 'unmanaged' = 'unmanaged';
      if (reservation) matched = 'reservation';
      else if (lease) matched = 'lease';
      return { ip: d.ip, mac: d.mac, matched };
    });

  res.json({ entries });
});

// On-demand refresh trigger for the "새로고침" button in the DHCP tab.
app.post("/api/dhcp/discover", async (req, res) => {
  if (!systemStatus.dhcpRunning) {
    return res.status(400).json({ error: "DHCP 서비스가 실행 중이 아닙니다." });
  }
  await discoverNetworkDevices();
  res.json({ success: true, leases, dhcpConsoleLogs });
});

// Reservations
// Creates or replaces the reservation for a MAC (re-adding an already-
// reserved MAC with a new IP updates it in place instead of creating a
// second, conflicting entry) and mirrors the change into `leases` as a
// permanent 'reserved' record — replacing whatever dynamic/stale lease that
// MAC held before under any casing/separator it was originally stored with.
// This is also what lets a currently-active real DHCP lease "upgrade"
// cleanly into a static reservation. Returns null if the requested IP is
// already reserved by a *different* MAC.
function upsertReservation(rawMac: string, ip: string, hostname: string): DhcpReservation | null {
  const mac = normalizeMac(rawMac);
  const ipConflict = reservations.find(r => normalizeMac(r.mac) !== mac && r.ip === ip);
  if (ipConflict) return null;

  reservations = reservations.filter(r => normalizeMac(r.mac) !== mac);
  const newRes: DhcpReservation = { id: "res-" + Date.now() + "-" + mac.replace(/:/g, ""), mac, ip, hostname };
  reservations.push(newRes);

  leases = leases.filter(l => normalizeMac(l.mac) !== mac || l.id === "host-pc-self");
  leases.push({
    id: "lease-res-" + Date.now() + "-" + mac.replace(/:/g, ""),
    ip,
    mac,
    hostname,
    interfaceName: dhcpConfig.interfaceName,
    leasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(), // 1 year
    status: 'reserved'
  });
  return newRes;
}

app.post("/api/dhcp/reservations", (req, res) => {
  const { mac, ip, hostname } = req.body;
  if (!mac || !ip || !hostname) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!isValidMac(mac)) {
    return res.status(400).json({ error: "MAC 주소 형식이 올바르지 않습니다 (예: AA:BB:CC:DD:EE:FF)." });
  }
  if (!isValidIPv4(ip)) {
    return res.status(400).json({ error: "IP 주소 형식이 올바르지 않습니다." });
  }

  const newRes = upsertReservation(mac, ip, hostname);
  if (!newRes) {
    return res.status(400).json({ error: `IP ${ip}는 이미 다른 MAC 주소로 예약되어 있습니다.` });
  }

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'SUCCESS',
    message: `Static reservation bound: MAC ${newRes.mac} to IP ${ip}`
  });

  saveState();
  res.json({ success: true, reservations, leases, dhcpConsoleLogs });
});

// Bulk-register static reservations from a CSV file the frontend has already
// parsed client-side into rows (same "parse in the browser, POST plain
// JSON" pattern as /api/hosts/bulk-import) — no multipart/file-upload
// handling or new dependency needed on this end. Invalid rows (bad MAC/IP
// format) and IP conflicts with a different MAC are counted and skipped
// rather than aborting the whole batch, so one bad line in a large CSV
// doesn't block the rest.
app.post("/api/dhcp/reservations/bulk-import", (req, res) => {
  const { reservations: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "가져올 예약 목록이 없습니다." });
  }

  let imported = 0;
  const skipped: { row: any; reason: string }[] = [];

  for (const row of rows) {
    const mac = typeof row?.mac === "string" ? row.mac : "";
    const ip = typeof row?.ip === "string" ? row.ip : "";
    const hostname = typeof row?.hostname === "string" && row.hostname.trim() ? row.hostname.trim() : mac;

    if (!mac || !ip) {
      skipped.push({ row, reason: "MAC 또는 IP 누락" });
      continue;
    }
    if (!isValidMac(mac)) {
      skipped.push({ row, reason: "MAC 주소 형식 오류" });
      continue;
    }
    if (!isValidIPv4(ip)) {
      skipped.push({ row, reason: "IP 주소 형식 오류" });
      continue;
    }
    const result = upsertReservation(mac, ip, hostname);
    if (!result) {
      skipped.push({ row, reason: `IP ${ip}가 다른 MAC에 이미 예약됨` });
      continue;
    }
    imported++;
  }

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'SUCCESS',
    message: `CSV 일괄 등록: ${imported}건 등록, ${skipped.length}건 건너뜀`
  });

  saveState();
  res.json({ success: true, reservations, leases, dhcpConsoleLogs, imported, skipped });
});

// Edit an existing reservation in place (previously the only way to change
// one was delete + re-add, which briefly frees the IP and drops the lease
// record). Handles the MAC itself being changed by clearing whatever lease
// the *old* MAC held before delegating to upsertReservation for the actual
// write with the new values.
app.put("/api/dhcp/reservations/:id", (req, res) => {
  const { id } = req.params;
  const existing = reservations.find(r => r.id === id);
  if (!existing) {
    return res.status(404).json({ error: "예약 정보를 찾을 수 없습니다." });
  }

  const { mac, ip, hostname } = req.body;
  if (!mac || !ip || !hostname) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!isValidMac(mac)) {
    return res.status(400).json({ error: "MAC 주소 형식이 올바르지 않습니다 (예: AA:BB:CC:DD:EE:FF)." });
  }
  if (!isValidIPv4(ip)) {
    return res.status(400).json({ error: "IP 주소 형식이 올바르지 않습니다." });
  }

  const newMac = normalizeMac(mac);
  const ipConflict = reservations.find(r => r.id !== id && normalizeMac(r.mac) !== newMac && r.ip === ip);
  if (ipConflict) {
    return res.status(400).json({ error: `IP ${ip}는 이미 다른 MAC 주소로 예약되어 있습니다.` });
  }

  reservations = reservations.filter(r => r.id !== id);
  leases = leases.filter(l => normalizeMac(l.mac) !== normalizeMac(existing.mac) || l.id === "host-pc-self");

  const updated = upsertReservation(mac, ip, hostname);
  if (!updated) {
    // Already checked for conflicts above, but restore rather than silently
    // dropping the entry if something still went wrong.
    reservations.push(existing);
    return res.status(400).json({ error: `IP ${ip}는 이미 다른 MAC 주소로 예약되어 있습니다.` });
  }

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'SUCCESS',
    message: `Reservation updated: MAC ${updated.mac} → IP ${ip}`
  });
  saveState();
  res.json({ success: true, reservations, leases, dhcpConsoleLogs });
});

app.delete("/api/dhcp/reservations/:id", (req, res) => {
  const { id } = req.params;
  const resToDelete = reservations.find(r => r.id === id);
  if (resToDelete) {
    reservations = reservations.filter(r => r.id !== id);
    // Remove static lease status — normalized comparison so this still
    // matches a lease whose MAC predates the case-normalization fix above.
    leases = leases.filter(l => normalizeMac(l.mac) !== normalizeMac(resToDelete.mac));
    dhcpConsoleLogs.push({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: `Reservation removed for MAC: ${resToDelete.mac}`
    });
    saveState();
  }
  res.json({ success: true, reservations, leases, dhcpConsoleLogs });
});

// Clear Lease Table
app.post("/api/dhcp/leases/clear", (req, res) => {
  leases = leases.filter(l => l.status === 'reserved'); // Keep reservations
  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'WARN',
    message: "Active lease log database flushed by administrator."
  });
  saveState();
  res.json({ success: true, leases, dhcpConsoleLogs });
});

// Return (revoke) a single lease. Removing it from `leases` here is the
// same internal structure the real DHCP server engine above checks via
// findAvailableIp()/conflict detection, so this immediately frees the IP
// for reassignment — there is no separate lease table to keep in sync.
app.delete("/api/dhcp/leases/:id", (req, res) => {
  const { id } = req.params;

  if (id === "host-pc-self") {
    return res.status(400).json({ error: "이 DHCP 서버(자기 자신)의 임대는 반환할 수 없습니다." });
  }

  const lease = leases.find(l => l.id === id);
  if (!lease) {
    return res.status(404).json({ error: "해당 임대 정보를 찾을 수 없습니다." });
  }

  leases = leases.filter(l => l.id !== id);
  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    message: `관리자가 IP 임대를 수동으로 반환했습니다: ${lease.ip} (MAC ${lease.mac}, ${lease.hostname})`
  });
  saveState();
  res.json({ success: true, leases, dhcpConsoleLogs });
});

// Manually "renew" a single lease as an admin action. Standard DHCP has no
// server-initiated renewal (the client drives renewal), so this instead: (1)
// pushes expiresAt back out by a full lease-time window as if a real renewal
// had just happened, (2) retries reverse DNS and adopts the result only if
// the current hostname is still an auto-generated "Device-N" placeholder
// (never overwrites a real, already-known hostname — reverseDnsLookup isn't
// guaranteed to be more accurate), and (3) pings the IP once for an immediate
// online/lastCheckedAt refresh. Reuses reverseDnsLookup/isValidIPv4/execFile
// already defined above rather than duplicating logic.
app.post("/api/dhcp/leases/:id/renew", async (req, res) => {
  const lease = leases.find(l => l.id === req.params.id);
  if (!lease) {
    return res.status(404).json({ error: "해당 임대 정보를 찾을 수 없습니다." });
  }

  lease.expiresAt = new Date(Date.now() + dhcpConfig.leaseTime * 60000).toISOString();

  const resolvedHostname = await reverseDnsLookup(lease.ip);
  if (resolvedHostname && /^Device-\d+$/.test(lease.hostname)) {
    lease.hostname = resolvedHostname;
  }

  if (isValidIPv4(lease.ip)) {
    await new Promise<void>((resolve) => {
      execFile("ping", ["-n", "1", "-w", "800", lease.ip], (error, stdout) => {
        lease.online = !error && /TTL=/i.test(stdout || "");
        lease.lastCheckedAt = new Date().toISOString();
        resolve();
      });
    });
  }

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'SUCCESS',
    message: `IP ${lease.ip} (${lease.hostname}) 임대를 관리자가 수동으로 갱신했습니다.`
  });

  saveState();
  res.json({ success: true, leases, dhcpConsoleLogs });
});


// --- Real TFTP server (RFC 1350, hand-rolled over dgram — same rationale as
// the DHCP engine above: no well-maintained npm TFTP server package exists,
// and the protocol itself is simple enough to implement directly) ---

function describeServiceBindError(serviceLabel: string, port: number, err: NodeJS.ErrnoException): string {
  if (err.code === "EACCES") {
    return `${serviceLabel} 서버 포트(${port}) 바인딩 실패 — 관리자 권한으로 실행하거나 다른 프로그램과의 포트 충돌을 확인하세요. (권한 부족: EACCES)`;
  }
  if (err.code === "EADDRINUSE") {
    return `${serviceLabel} 서버 포트(${port}) 바인딩 실패 — 이미 다른 프로그램이 포트 ${port}을 사용 중입니다. (EADDRINUSE)`;
  }
  return `${serviceLabel} 서버 포트(${port}) 바인딩 실패: ${err.message}`;
}

// Starts a transfer log entry ('IN_PROGRESS') and finalizes it later
// ('COMPLETED'/'FAILED'). saveState() is only called at these two points
// (never per-packet) — a TFTP transfer can involve thousands of 512-byte
// blocks, and saveState() does a full synchronous file write, so calling it
// per-block would make transfers unusably slow.
function logTransferStart(service: 'TFTP' | 'FTP', operation: 'UPLOAD' | 'DOWNLOAD', clientIp: string, fileName: string, fileSize: number): TransferLog {
  const entry: TransferLog = {
    id: "transfer-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    service,
    clientIp: clientIp.replace(/^::ffff:/, ""),
    operation,
    fileName,
    fileSize,
    progress: 0,
    speed: '',
    status: 'IN_PROGRESS',
    timestamp: new Date().toISOString()
  };
  transferLogs.push(entry);
  saveState();
  return entry;
}

function finalizeTransferLog(entry: TransferLog, success: boolean, finalBytes: number, elapsedMs?: number) {
  entry.status = success ? 'COMPLETED' : 'FAILED';
  entry.fileSize = finalBytes;
  if (success) entry.progress = 100;
  if (elapsedMs && elapsedMs > 0) {
    const seconds = Math.max(elapsedMs / 1000, 0.05);
    entry.speed = `${((finalBytes / (1024 * 1024)) / seconds).toFixed(1)} MB/s`;
  } else {
    entry.speed = '-';
  }
  saveState();
}

const TFTP_OPCODE = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5 };
const TFTP_BLOCK_SIZE = 512;
const TFTP_TIMEOUT_MS = 3000;
const TFTP_MAX_RETRIES = 5;

interface TftpSession {
  mode: 'read' | 'write';
  clientAddress: string;
  clientPort: number;
  fh: fs.promises.FileHandle;
  filePath: string;
  blockNum: number; // last block fully ACKed (read) / written (write)
  pendingBlock: number; // block number of the in-flight packet awaiting a response
  lastPacket: Buffer;
  isFinalBlock: boolean; // read sessions only: whether pendingBlock is the last one
  transferredBytes: number;
  logEntry: TransferLog;
  startedAt: number;
  retries: number;
  timer: NodeJS.Timeout | null;
}

let tftpSocket: dgram.Socket | null = null;
const tftpSessions = new Map<string, TftpSession>();

function buildTftpDataPacket(block: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(TFTP_OPCODE.DATA, 0);
  header.writeUInt16BE(block & 0xffff, 2);
  return Buffer.concat([header, data]);
}

function buildTftpAckPacket(block: number): Buffer {
  const packet = Buffer.alloc(4);
  packet.writeUInt16BE(TFTP_OPCODE.ACK, 0);
  packet.writeUInt16BE(block & 0xffff, 2);
  return packet;
}

function buildTftpErrorPacket(code: number, message: string): Buffer {
  const msgBuf = Buffer.from(message, "ascii");
  const packet = Buffer.alloc(4 + msgBuf.length + 1);
  packet.writeUInt16BE(TFTP_OPCODE.ERROR, 0);
  packet.writeUInt16BE(code, 2);
  msgBuf.copy(packet, 4);
  packet[4 + msgBuf.length] = 0;
  return packet;
}

function parseTftpRequest(msg: Buffer): { filename: string; mode: string } | null {
  const nullIdx1 = msg.indexOf(0, 2);
  if (nullIdx1 === -1) return null;
  // "utf8" rather than "ascii": ascii strips the high bit off every byte, so
  // any non-ASCII filename (e.g. Korean, sent as UTF-8 bytes by every modern
  // TFTP client) came out corrupted. utf8 decodes plain ASCII names
  // identically while also handling Korean/other UTF-8 filenames correctly.
  const filename = msg.toString("utf8", 2, nullIdx1);
  const nullIdx2 = msg.indexOf(0, nullIdx1 + 1);
  if (nullIdx2 === -1) return null;
  const mode = msg.toString("ascii", nullIdx1 + 1, nullIdx2).toLowerCase();
  if (!filename) return null;
  return { filename, mode };
}

function sendTftpError(socket: dgram.Socket, address: string, port: number, code: number, message: string) {
  socket.send(buildTftpErrorPacket(code, message), port, address, () => { /* best effort */ });
}

function tftpSessionKey(address: string, port: number): string {
  return `${address}:${port}`;
}

function clearTftpTimer(session: TftpSession) {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function cleanupTftpSession(key: string, success: boolean) {
  const session = tftpSessions.get(key);
  if (!session) return;
  clearTftpTimer(session);
  tftpSessions.delete(key);
  session.fh.close().catch(() => { /* already closed */ });
  if (session.logEntry.status === 'IN_PROGRESS') {
    finalizeTransferLog(session.logEntry, success, session.transferredBytes, Date.now() - session.startedAt);
  }
}

function armTftpTimer(socket: dgram.Socket, key: string) {
  const session = tftpSessions.get(key);
  if (!session) return;
  clearTftpTimer(session);
  session.timer = setTimeout(() => {
    const s = tftpSessions.get(key);
    if (!s) return;
    s.retries++;
    if (s.retries > TFTP_MAX_RETRIES) {
      cleanupTftpSession(key, false);
      return;
    }
    socket.send(s.lastPacket, s.clientPort, s.clientAddress, () => { /* best effort */ });
    armTftpTimer(socket, key);
  }, TFTP_TIMEOUT_MS);
}

async function sendNextTftpDataBlock(socket: dgram.Socket, key: string) {
  const session = tftpSessions.get(key);
  if (!session) return;
  const nextBlock = session.blockNum + 1;
  const buf = Buffer.alloc(TFTP_BLOCK_SIZE);
  const { bytesRead } = await session.fh.read(buf, 0, TFTP_BLOCK_SIZE, (nextBlock - 1) * TFTP_BLOCK_SIZE);
  const data = buf.subarray(0, bytesRead);
  const packet = buildTftpDataPacket(nextBlock, data);
  session.pendingBlock = nextBlock;
  session.isFinalBlock = bytesRead < TFTP_BLOCK_SIZE;
  session.lastPacket = packet;
  session.retries = 0;
  socket.send(packet, session.clientPort, session.clientAddress, () => { /* best effort */ });
  armTftpTimer(socket, key);
}

async function handleTftpRrq(socket: dgram.Socket, rinfo: dgram.RemoteInfo, filename: string) {
  const key = tftpSessionKey(rinfo.address, rinfo.port);
  const filePath = resolveServedPath(tftpFtpConfig.rootFolder, filename);
  if (!filePath) { sendTftpError(socket, rinfo.address, rinfo.port, 2, "Access violation"); return; }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) throw new Error("is a directory");
  } catch {
    sendTftpError(socket, rinfo.address, rinfo.port, 1, "File not found");
    return;
  }

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, "r");
  } catch (error: any) {
    sendTftpError(socket, rinfo.address, rinfo.port, 2, `Access violation: ${error.message}`);
    return;
  }

  const logEntry = logTransferStart('TFTP', 'DOWNLOAD', rinfo.address, path.basename(filename), stat.size);
  tftpSessions.set(key, {
    mode: 'read',
    clientAddress: rinfo.address,
    clientPort: rinfo.port,
    fh,
    filePath,
    blockNum: 0,
    pendingBlock: 0,
    lastPacket: Buffer.alloc(0),
    isFinalBlock: false,
    transferredBytes: 0,
    logEntry,
    startedAt: Date.now(),
    retries: 0,
    timer: null
  });
  await sendNextTftpDataBlock(socket, key);
}

async function handleTftpWrq(socket: dgram.Socket, rinfo: dgram.RemoteInfo, filename: string) {
  const key = tftpSessionKey(rinfo.address, rinfo.port);
  const filePath = resolveServedPath(tftpFtpConfig.rootFolder, filename);
  if (!filePath) { sendTftpError(socket, rinfo.address, rinfo.port, 2, "Access violation"); return; }

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(filePath, "w");
  } catch (error: any) {
    sendTftpError(socket, rinfo.address, rinfo.port, 2, `Access violation: ${error.message}`);
    return;
  }

  const logEntry = logTransferStart('TFTP', 'UPLOAD', rinfo.address, path.basename(filename), 0);
  const ackPacket = buildTftpAckPacket(0);
  tftpSessions.set(key, {
    mode: 'write',
    clientAddress: rinfo.address,
    clientPort: rinfo.port,
    fh,
    filePath,
    blockNum: 0,
    pendingBlock: 0,
    lastPacket: ackPacket,
    isFinalBlock: false,
    transferredBytes: 0,
    logEntry,
    startedAt: Date.now(),
    retries: 0,
    timer: null
  });
  socket.send(ackPacket, rinfo.port, rinfo.address, () => { /* best effort */ });
  armTftpTimer(socket, key);
}

async function handleTftpAck(socket: dgram.Socket, key: string, block: number) {
  const session = tftpSessions.get(key);
  if (!session || session.mode !== 'read') return;
  if (block !== session.pendingBlock) return; // stale/duplicate ACK, ignore

  clearTftpTimer(session);
  session.blockNum = block;
  session.transferredBytes += session.lastPacket.length - 4; // exclude the 4-byte DATA header
  if (session.isFinalBlock) {
    cleanupTftpSession(key, true);
    return;
  }
  await sendNextTftpDataBlock(socket, key);
}

async function handleTftpData(socket: dgram.Socket, key: string, block: number, payload: Buffer) {
  const session = tftpSessions.get(key);
  if (!session || session.mode !== 'write') return;

  if (block === session.blockNum) {
    // Duplicate of the last already-written block (our ACK was likely lost) — re-ACK without rewriting.
    socket.send(session.lastPacket, session.clientPort, session.clientAddress, () => { /* best effort */ });
    armTftpTimer(socket, key);
    return;
  }
  if (block !== session.blockNum + 1) return; // out of order, ignore

  try {
    await session.fh.write(payload, 0, payload.length, session.blockNum * TFTP_BLOCK_SIZE);
  } catch (error: any) {
    sendTftpError(socket, session.clientAddress, session.clientPort, 3, `Disk write error: ${error.message}`);
    cleanupTftpSession(key, false);
    return;
  }

  session.blockNum = block;
  session.transferredBytes += payload.length;
  session.logEntry.fileSize = session.transferredBytes;
  const ackPacket = buildTftpAckPacket(block);
  session.pendingBlock = block;
  session.lastPacket = ackPacket;
  session.retries = 0;
  socket.send(ackPacket, session.clientPort, session.clientAddress, () => { /* best effort */ });

  if (payload.length < TFTP_BLOCK_SIZE) {
    clearTftpTimer(session);
    cleanupTftpSession(key, true);
    return;
  }
  armTftpTimer(socket, key);
}

function handleTftpPacket(socket: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo) {
  if (msg.length < 2) return;
  const opcode = msg.readUInt16BE(0);
  const key = tftpSessionKey(rinfo.address, rinfo.port);

  if (opcode === TFTP_OPCODE.RRQ || opcode === TFTP_OPCODE.WRQ) {
    if (tftpSessions.has(key)) return; // ignore a duplicate initial request for an already-active transfer
    const parsed = parseTftpRequest(msg);
    if (!parsed) { sendTftpError(socket, rinfo.address, rinfo.port, 4, "Illegal TFTP operation"); return; }
    const task = opcode === TFTP_OPCODE.RRQ
      ? handleTftpRrq(socket, rinfo, parsed.filename)
      : handleTftpWrq(socket, rinfo, parsed.filename);
    task.catch(e => console.error("TFTP 요청 처리 오류", e));
    return;
  }

  const session = tftpSessions.get(key);
  if (!session) return; // unrelated/expired transfer, ignore silently

  if (opcode === TFTP_OPCODE.ACK) {
    handleTftpAck(socket, key, msg.readUInt16BE(2)).catch(e => console.error("TFTP ACK 처리 오류", e));
  } else if (opcode === TFTP_OPCODE.DATA) {
    handleTftpData(socket, key, msg.readUInt16BE(2), msg.subarray(4)).catch(e => console.error("TFTP DATA 처리 오류", e));
  } else if (opcode === TFTP_OPCODE.ERROR) {
    cleanupTftpSession(key, false);
  }
}

function startTftpServer(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (tftpSocket) { resolve({ success: true }); return; }

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;

    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) {
        logDhcp('WARN', `TFTP 서버 소켓 오류: ${err.message}`);
        return;
      }
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve({ success: false, error: describeServiceBindError("TFTP", tftpFtpConfig.tftpPort, err) });
    });

    socket.on("message", (msg, rinfo) => {
      try { handleTftpPacket(socket, msg, rinfo); } catch (e) { console.error("TFTP 패킷 처리 중 오류", e); }
    });

    socket.bind(tftpFtpConfig.tftpPort, "0.0.0.0", () => {
      if (settled) return;
      settled = true;
      tftpSocket = socket;
      resolve({ success: true });
    });
  });
}

function stopTftpServer() {
  if (tftpSocket) {
    try { tftpSocket.close(); } catch { /* already closed */ }
    tftpSocket = null;
  }
  for (const key of Array.from(tftpSessions.keys())) {
    cleanupTftpSession(key, false);
  }
}

// --- Real FTP server (via the `ftp-srv` package — unlike TFTP, a mature,
// actively-used pure-JS FTP server library exists, so unlike DHCP/TFTP there
// was no reason to hand-roll this one) ---

// ftp-srv defaults to a verbose bunyan logger writing to stdout for every
// command; this app surfaces status via the in-app log panel instead, so
// silence it rather than spamming the (usually invisible, packaged-exe)
// console.
function createSilentFtpLogger(): any {
  const noop = () => { /* silenced */ };
  const logger: any = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  logger.child = () => createSilentFtpLogger();
  return logger;
}

// ftp-srv registers process-level SIGTERM/SIGINT/SIGQUIT handlers on every
// `new FtpSrv(...)` and never removes them on close() (a library quirk) — so
// repeated toggle-off/toggle-on cycles would otherwise accumulate listeners
// and eventually trip Node's MaxListenersExceededWarning.
process.setMaxListeners(Math.max(process.getMaxListeners(), 30));

// Resolves the IP address ftp-srv should hand a client for PASV data
// connections: the address of whichever local adapter shares a subnet with
// the connecting client (so LAN devices get a reachable LAN IP), falling
// back to loopback for local testing and to the first adapter otherwise.
function resolveFtpPasvAddress(remoteAddress: string): string {
  const clean = remoteAddress.replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1") return "127.0.0.1";

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if ((net.family === "IPv4" || (net.family as any) === 4) && !net.internal && isIpInSubnet(clean, net.address, net.netmask)) {
        return net.address;
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if ((net.family === "IPv4" || (net.family as any) === 4) && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

let ftpServerInstance: InstanceType<typeof FtpSrv> | null = null;

function startFtpServer(): Promise<{ success: boolean; error?: string }> {
  if (ftpServerInstance) return Promise.resolve({ success: true });

  const server = new FtpSrv({
    url: `ftp://0.0.0.0:${tftpFtpConfig.ftpPort}`,
    pasv_url: resolveFtpPasvAddress,
    pasv_min: 50000,
    pasv_max: 50099,
    greeting: ["Network Server Suite FTP"],
    anonymous: false,
    log: createSilentFtpLogger()
  } as any);

  // Whitelist-only: the username+password must exactly match one of
  // ftpCredentials. An empty list means nobody can log in — there is no
  // anonymous/open-access fallback (TFTP, by contrast, still has no
  // authentication concept at all; that's a protocol-level limitation, not a
  // choice, since RFC 1350 has no login step).
  server.on('login', ({ connection, username, password }: any, resolveLogin: any, rejectLogin: any) => {
    const match = ftpCredentials.find(c => c.username === username && c.password === password);
    if (!match) { rejectLogin(new Error("아이디 또는 비밀번호가 올바르지 않습니다.")); return; }

    connection.on('STOR', (err: Error | null, filePath: string) => {
      if (err) { logDhcp('WARN', `FTP 업로드 실패: ${err.message}`); return; }
      try {
        const stat = fs.statSync(filePath);
        const entry = logTransferStart('FTP', 'UPLOAD', connection.ip || 'unknown', path.basename(filePath), stat.size);
        finalizeTransferLog(entry, true, stat.size);
      } catch { /* file may already be gone; nothing meaningful to log */ }
    });

    connection.on('RETR', (err: Error | null, filePath: string) => {
      if (err) { logDhcp('WARN', `FTP 다운로드 실패: ${err.message}`); return; }
      try {
        const stat = fs.statSync(filePath);
        const entry = logTransferStart('FTP', 'DOWNLOAD', connection.ip || 'unknown', path.basename(filePath), stat.size);
        finalizeTransferLog(entry, true, stat.size);
      } catch { /* ignore */ }
    });

    resolveLogin({ root: tftpFtpConfig.rootFolder });
  });

  // Not in ftp-srv's .on() overload set (only login/disconnect/client-error
  // are typed) even though the library does emit it — cast to bypass.
  (server as any).on('server-error', ({ error }: any) => {
    logDhcp('WARN', `FTP 서버 오류: ${error?.message || error}`);
  });

  return server.listen()
    .then(() => {
      ftpServerInstance = server;
      return { success: true };
    })
    .catch((err: NodeJS.ErrnoException) => {
      return { success: false, error: describeServiceBindError("FTP", tftpFtpConfig.ftpPort, err) };
    });
}

function stopFtpServer(): Promise<void> {
  if (!ftpServerInstance) return Promise.resolve();
  const server = ftpServerInstance;
  ftpServerInstance = null;
  return server.close().catch(() => { /* best effort */ });
}

// TFTP / FTP File Service Controls
app.post("/api/tftpftp/toggle", async (req, res) => {
  const { service, enabled } = req.body; // 'TFTP' or 'FTP'

  if (service === 'TFTP') {
    if (enabled) {
      const result = await startTftpServer();
      if (!result.success) {
        logDhcp('WARN', result.error || "TFTP 서버를 시작할 수 없습니다.");
        return res.json({ success: false, error: result.error, systemStatus, tftpFtpConfig });
      }
      logDhcp('SUCCESS', `TFTP 서버가 포트 ${tftpFtpConfig.tftpPort}에서 시작되었습니다. 공유 폴더: ${tftpFtpConfig.rootFolder}`);
    } else {
      stopTftpServer();
      logDhcp('INFO', "TFTP 서버가 중지되었습니다.");
    }
    systemStatus.tftpRunning = enabled;
    tftpFtpConfig.tftpEnabled = enabled;
  } else if (service === 'FTP') {
    if (enabled) {
      const result = await startFtpServer();
      if (!result.success) {
        logDhcp('WARN', result.error || "FTP 서버를 시작할 수 없습니다.");
        return res.json({ success: false, error: result.error, systemStatus, tftpFtpConfig });
      }
      logDhcp('SUCCESS', `FTP 서버가 포트 ${tftpFtpConfig.ftpPort}에서 시작되었습니다. 공유 폴더: ${tftpFtpConfig.rootFolder}`);
    } else {
      await stopFtpServer();
      logDhcp('INFO', "FTP 서버가 중지되었습니다.");
    }
    systemStatus.ftpRunning = enabled;
    tftpFtpConfig.ftpEnabled = enabled;
  }

  saveState();
  res.json({ success: true, systemStatus, tftpFtpConfig });
});

app.post("/api/tftpftp/config", (req, res) => {
  const { rootFolder, tftpPort, ftpPort } = req.body;

  if (rootFolder !== undefined) {
    if (typeof rootFolder !== "string" || rootFolder.trim() === "") {
      return res.status(400).json({ error: "폴더 경로를 입력해야 합니다." });
    }

    const normalizedPath = path.resolve(rootFolder.trim());
    if (!path.isAbsolute(normalizedPath)) {
      return res.status(400).json({ error: "절대 경로만 입력할 수 있습니다." });
    }

    if (!fs.existsSync(normalizedPath)) {
      try {
        fs.mkdirSync(normalizedPath, { recursive: true });
      } catch (error: any) {
        return res.status(400).json({ error: `폴더를 생성할 수 없습니다: ${error.message}` });
      }
    } else {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(normalizedPath);
      } catch (error: any) {
        return res.status(400).json({ error: `폴더 정보를 확인할 수 없습니다: ${error.message}` });
      }
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: "지정한 경로가 폴더가 아닙니다." });
      }
    }

    try {
      fs.accessSync(normalizedPath, fs.constants.W_OK);
    } catch (error: any) {
      return res.status(400).json({ error: `폴더에 쓰기 권한이 없습니다: ${error.message}` });
    }

    tftpFtpConfig.rootFolder = normalizedPath;
  }

  if (tftpPort) tftpFtpConfig.tftpPort = Number(tftpPort);
  if (ftpPort) tftpFtpConfig.ftpPort = Number(ftpPort);

  saveState();
  res.json({ success: true, tftpFtpConfig });
});

// Opens a native Windows folder-picker on the server machine (this app is a
// locally-run desktop suite, so "the server machine" is the same machine the
// browser is on), so the shared folder can be selected instead of
// hand-typing a path. Only fills in the field on the frontend — the existing
// /api/tftpftp/config route above still does the actual validation/apply
// when the user saves.
//
// Uses the Shell.Application COM folder browser with the BIF_USENEWUI style
// (BIF_NEWDIALOGSTYLE | BIF_EDITBOX, 0x50) instead of WinForms'
// FolderBrowserDialog: the plain FolderBrowserDialog is the legacy
// SHBrowseForFolder tree-only dialog with no address/path field at all, so a
// path could only be reached by clicking through the tree level by level and
// pasting was impossible. BIF_EDITBOX adds a real text box at the bottom of
// the dialog that accepts typing/pasting a full path directly (and
// auto-navigates the tree to match), while BIF_NEWDIALOGSTYLE makes the
// window resizable with normal Explorer context menus (new folder,
// rename, delete). BIF_RETURNONLYFSDIRS (0x1) keeps virtual/non-filesystem
// nodes (Control Panel, etc.) from being selectable, hence 0x51 total. The
// hidden TopMost owner form is only there so the dialog reliably comes to
// the foreground instead of opening behind the browser window.
app.post("/api/tftpftp/browse-folder", async (req, res) => {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$ownerHandle = $owner.Handle
$shellApp = New-Object -ComObject Shell.Application
$folder = $shellApp.BrowseForFolder($ownerHandle.ToInt32(), 'TFTP/FTP 공유 폴더 선택 (경로를 직접 입력하거나 붙여넣을 수 있습니다)', 0x51, 0)
$owner.Dispose()
if ($folder -ne $null) { Write-Output $folder.Self.Path } else { Write-Output '__CANCELLED__' }
`;
  const result = await runPowerShellScript(script);
  if (!result.success) {
    return res.status(500).json({ error: result.error || result.stderr || "폴더 선택 창을 열 수 없습니다." });
  }
  const output = result.stdout.trim();
  if (!output || output === "__CANCELLED__") {
    return res.json({ success: true, cancelled: true });
  }
  res.json({ success: true, path: output });
});

// Whitelisted FTP login CRUD. The FTP server (below) checks every USER/PASS
// against this list — there's no anonymous fallback, so at least one entry
// must exist before FTP is usable.
app.post("/api/tftpftp/credentials", (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "아이디와 비밀번호를 모두 입력해야 합니다." });
  }
  const trimmedUsername = username.trim();
  if (ftpCredentials.some(c => c.username === trimmedUsername)) {
    return res.status(400).json({ error: "이미 등록된 아이디입니다." });
  }
  ftpCredentials.push({ id: "ftpcred-" + Date.now(), username: trimmedUsername, password });
  saveState();
  res.json({ success: true, ftpCredentials });
});

app.delete("/api/tftpftp/credentials/:id", (req, res) => {
  ftpCredentials = ftpCredentials.filter(c => c.id !== req.params.id);
  saveState();
  res.json({ success: true, ftpCredentials });
});

// Resolves a user-supplied file name against the current served-folder root,
// rejecting any path that would escape outside of it (e.g. via "../").
function resolveServedPath(baseDir: string, name: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, name);
  // path.resolve() of a drive root (e.g. "D:\") already ends with a
  // separator, so blindly appending another one (as this used to do)
  // produced "D:\\" and every file directly under that root would then fail
  // resolvedPath.startsWith(...) — rejecting every read/write as an "escape"
  // even though nothing escaped anything. Only append the separator when the
  // base doesn't already end with one.
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(baseWithSep)) {
    return null;
  }
  return resolvedPath;
}

// File Management inside TFTP/FTP Served directory
app.get("/api/files", (req, res) => {
  const baseDir = tftpFtpConfig.rootFolder;
  try {
    const files = fs.readdirSync(baseDir).flatMap(fileName => {
      const filePath = path.join(baseDir, fileName);
      try {
        const stat = fs.statSync(filePath);
        return [{
          name: fileName,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          modifiedTime: stat.mtime.toISOString()
        }];
      } catch {
        // Sharing a drive root exposes OS-protected entries (e.g. "System
        // Volume Information", "$RECYCLE.BIN") that even an administrator
        // can't stat() — skip them instead of failing the whole listing.
        return [];
      }
    });
    res.json({ files });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/files/create", (req, res) => {
  const { name, content } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });

  const baseDir = tftpFtpConfig.rootFolder;
  const filePath = resolveServedPath(baseDir, name);
  if (!filePath) return res.status(400).json({ error: "잘못된 파일 경로입니다." });

  try {
    fs.writeFileSync(filePath, content || "");
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/files/:name", (req, res) => {
  const { name } = req.params;
  const baseDir = tftpFtpConfig.rootFolder;
  const filePath = resolveServedPath(baseDir, name);
  if (!filePath) return res.status(400).json({ error: "잘못된 파일 경로입니다." });

  try {
    // fs.unlinkSync throws EPERM/EISDIR on directories — fs.rmSync handles both
    // regular files and directories (recursively) so delete never silently fails
    // just because the entry happens to be a folder.
    fs.rmSync(filePath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: `파일을 삭제할 수 없습니다: ${error.message}` });
  }
});

// Clear transfer logs
app.post("/api/tftpftp/transfers/clear", (req, res) => {
  transferLogs = [];
  saveState();
  res.json({ success: true, transferLogs });
});


// TERMINAL & AUTOMATION SCRIPTS
// `username` is intentionally not required: a device can be registered with
// no account info at all (SSH still needs credentials to authenticate at
// connect time, but a TELNET device's own login prompt can instead be
// answered by the script's own commands after a raw connect — see the
// `!host.password` branch in runScriptExecution/runTelnetExecution below).
app.post("/api/hosts", (req, res) => {
  const { name, ip, port, protocol, username, password } = req.body;
  if (!name || !ip || !port || !protocol) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const id = "host-" + Date.now();
  const host: TerminalHost = { id, name, ip, port: Number(port), protocol, username: username || "", password };
  terminalHosts.push(host);
  saveState();
  res.json({ success: true, terminalHosts });
});

app.delete("/api/hosts/:id", (req, res) => {
  const { id } = req.params;
  terminalHosts = terminalHosts.filter(h => h.id !== id);
  saveState();
  res.json({ success: true, terminalHosts });
});

// Update an existing device profile. Reuses the same field validation as the
// create route. Password is optional here: an empty/omitted password leaves
// the previously stored password untouched (edit forms don't re-display the
// stored secret, so a blank field means "unchanged", not "clear it").
app.put("/api/hosts/:id", (req, res) => {
  const { id } = req.params;
  const { name, ip, port, protocol, username, password } = req.body;
  if (!name || !ip || !port || !protocol) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const host = terminalHosts.find(h => h.id === id);
  if (!host) {
    return res.status(404).json({ error: "Host not found" });
  }

  host.name = name;
  host.ip = ip;
  host.port = Number(port);
  host.protocol = protocol;
  host.username = username || "";
  if (password) host.password = password;

  saveState();
  res.json({ success: true, terminalHosts });
});

// Bulk-import devices discovered via DHCP leases into the terminal device
// registry. All imported devices share the same connection profile
// (protocol/port/username/password); only name/ip vary per device. Devices
// whose IP is already registered are skipped to avoid duplicate entries.
app.post("/api/hosts/bulk-import", (req, res) => {
  const { devices, protocol, port, username, password } = req.body;
  if (!Array.isArray(devices) || devices.length === 0 || !protocol || !port) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const existingIps = new Set(terminalHosts.map(h => h.ip));
  let imported = 0;
  let skipped = 0;

  devices.forEach((device: { name: string; ip: string }, idx: number) => {
    if (!device || !device.ip || !device.name) {
      skipped++;
      return;
    }
    if (existingIps.has(device.ip)) {
      skipped++;
      return;
    }
    const host: TerminalHost = {
      id: `host-${Date.now()}-${idx}`,
      name: device.name,
      ip: device.ip,
      port: Number(port),
      protocol,
      username: username || "",
      password
    };
    terminalHosts.push(host);
    existingIps.add(device.ip);
    imported++;
  });

  saveState();
  res.json({ success: true, terminalHosts, imported, skipped });
});

// Bulk-update connection/account fields (protocol/port/username/password) for
// multiple devices at once. name/ip are intentionally never touched here —
// this route is for account info only, not device identity edits. Only
// fields explicitly present in the request body are applied; anything
// omitted keeps each host's existing value.
app.post("/api/hosts/bulk-update", (req, res) => {
  const { ids, protocol, port, username, password } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  terminalHosts.forEach(host => {
    if (!ids.includes(host.id)) return;
    if (protocol) host.protocol = protocol;
    if (port) host.port = Number(port);
    if (username) host.username = username;
    if (password) host.password = password;
  });

  saveState();
  res.json({ success: true, terminalHosts });
});

// Bulk-delete multiple device profiles at once.
app.post("/api/hosts/bulk-delete", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  terminalHosts = terminalHosts.filter(h => !ids.includes(h.id));
  saveState();
  res.json({ success: true, terminalHosts });
});

app.post("/api/scripts", (req, res) => {
  const { name, description, commands } = req.body;
  if (!name || !commands || !Array.isArray(commands)) {
    return res.status(400).json({ error: "Name and commands array are required" });
  }

  const id = "script-" + Date.now();
  const script: CommandScript = { id, name, description: description || "", commands };
  commandScripts.push(script);
  saveState();
  res.json({ success: true, commandScripts });
});

app.delete("/api/scripts/:id", (req, res) => {
  const { id } = req.params;
  commandScripts = commandScripts.filter(s => s.id !== id);
  saveState();
  res.json({ success: true, commandScripts });
});

// Update an existing automation script. Reuses the same field validation as
// the create route.
app.put("/api/scripts/:id", (req, res) => {
  const { id } = req.params;
  const { name, description, commands } = req.body;
  if (!name || !commands || !Array.isArray(commands)) {
    return res.status(400).json({ error: "Name and commands array are required" });
  }

  const script = commandScripts.find(s => s.id === id);
  if (!script) {
    return res.status(404).json({ error: "Script not found" });
  }

  script.name = name;
  script.description = description || "";
  script.commands = commands;

  saveState();
  res.json({ success: true, commandScripts });
});

// Saved Batch Jobs ("device list + script" combo, replayed with one click).
// Purely CRUD here — execution stays a frontend fan-out over the existing
// /api/scripts/execute endpoint (see TerminalAutomation.tsx).
app.post("/api/batch-jobs", (req, res) => {
  const { name, hostIds, scriptId } = req.body;
  if (!name || !Array.isArray(hostIds) || hostIds.length === 0 || !scriptId) {
    return res.status(400).json({ error: "name, hostIds(1개 이상), scriptId가 필요합니다." });
  }

  const job: BatchJob = { id: "batch-" + Date.now(), name, hostIds, scriptId };
  batchJobs.push(job);
  saveState();
  res.json({ success: true, batchJobs });
});

app.delete("/api/batch-jobs/:id", (req, res) => {
  const { id } = req.params;
  batchJobs = batchJobs.filter(j => j.id !== id);
  saveState();
  res.json({ success: true, batchJobs });
});

// Automation Script Execution Engine
// Real SSH (ssh2) / Telnet (telnet-client) automation. No canned/simulated
// output: every log line below either comes from the remote device or from
// a concrete connection/authentication failure.

function nowStr() {
  return new Date().toLocaleTimeString();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a SecureCRT-style "<sN>" (or "<sN.N>") delay tag optionally prefixed
// on a scripted command line, e.g. "<s1>sh run" -> wait 1000ms then send
// "sh run"; "<s2.5>ping 8.8.8.8" -> wait 2500ms then send "ping 8.8.8.8".
// Commands without a tag keep the previous fixed 1200ms inter-command delay
// so untagged scripts behave exactly as before this feature was added.
function parseDelayTag(raw: string): { cmd: string; waitMs: number; tagged: boolean } {
  const match = raw.match(/^<s(\d+(?:\.\d+)?)>\s*/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    return { cmd: raw.slice(match[0].length), waitMs: Math.max(0, seconds * 1000), tagged: true };
  }
  return { cmd: raw, waitMs: 1200, tagged: false };
}

// Translate a raw connection/auth error into a clear Korean diagnostic line,
// while preserving the original error message for troubleshooting.
function describeConnectionError(err: any, host: TerminalHost): string {
  const rawMsg = (err && (err.message || String(err))) || "알 수 없는 오류";
  const code = err?.code;
  const level = err?.level;

  if (code === "ECONNREFUSED") {
    return `[오류] ${host.ip}:${host.port} 연결이 거부되었습니다. 포트/방화벽을 확인하세요. (${rawMsg})`;
  }
  if (code === "ETIMEDOUT" || level === "client-timeout" || /timed out|timeout/i.test(rawMsg)) {
    return `[오류] ${host.ip}:${host.port} 연결 시간이 초과되었습니다. 호스트가 응답하지 않습니다. (${rawMsg})`;
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `[오류] ${host.ip}:${host.port} 호스트에 도달할 수 없습니다. 네트워크 경로를 확인하세요. (${rawMsg})`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `[오류] 호스트 주소 "${host.ip}"를 확인할 수 없습니다. 주소를 다시 확인하세요. (${rawMsg})`;
  }
  if (level === "client-authentication" || /auth|login|password|failed login/i.test(rawMsg)) {
    return `[오류] 사용자 인증에 실패했습니다. 아이디/비밀번호를 확인하세요. (${rawMsg})`;
  }
  if (level === "client-socket" || code) {
    return `[오류] ${host.ip}:${host.port} 접속 중 네트워크 오류가 발생했습니다: ${rawMsg}`;
  }
  return `[오류] ${host.ip}:${host.port} 접속 중 알 수 없는 오류가 발생했습니다: ${rawMsg}`;
}

// Registry of live, still-open SSH/Telnet sessions. A ScriptExecution enters
// this map once its scripted commands (if any) have all been dispatched and
// the underlying connection is deliberately kept open, so that manual CLI
// input (POST /api/terminal/send) can keep writing into the same session
// afterwards. Entries are removed when the connection closes/errors, or when
// the user explicitly disconnects (POST /api/terminal/disconnect).
interface LiveSession {
  protocol: 'SSH' | 'TELNET';
  write: (data: string) => void;
  close: () => void;
}
const liveSessions = new Map<string, LiveSession>();

// execIds whose last `logs` entry is an unterminated raw-stream line that the
// next stream chunk should keep extending, rather than starting a fresh
// entry — see appendStreamChunk() below.
const openStreamLineExecIds = new Set<string>();

// Tear down a live session (if any) and mark the corresponding execution as
// no longer having an open connection. Safe to call even if the session was
// already removed (e.g. the underlying socket closed on its own right after
// an explicit disconnect request) — in that case this is a harmless no-op
// beyond the optional log line.
function closeLiveSession(execId: string, logMessage?: string) {
  const session = liveSessions.get(execId);
  if (session) {
    try { session.close(); } catch { /* already closed */ }
    liveSessions.delete(execId);
  }
  openStreamLineExecIds.delete(execId);
  const currentExec = scriptExecutions.find(e => e.id === execId);
  if (currentExec) {
    currentExec.sessionOpen = false;
    if (logMessage) currentExec.logs.push(logMessage);
  }
}

// Clean up raw bytes coming back from real network gear (switches/routers)
// before they hit the log/UI. Devices commonly send ANSI/VT100 escape
// sequences (cursor movement, colors), backspace characters used to erase
// "--More--" paging prompts or echoed input, and other C0 control bytes —
// none of which render sensibly as plain text in the web log viewer. This is
// deliberately practical rather than a full terminal emulator: backspace
// handling only unwinds within a single chunk (no cross-chunk state), which
// is enough to clean up the common paging/erase patterns real devices use.
function sanitizeTerminalOutput(raw: string): string {
  let text = raw;

  // ANSI CSI sequences (cursor movement, colors, clear-line, etc.)
  text = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  // ANSI OSC sequences (window title, etc.), terminated by BEL or ST
  text = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  // Charset designation and other 2-byte escapes, then any leftover lone escape byte
  text = text.replace(/\x1b[()][0-9A-Za-z]/g, "");
  text = text.replace(/\x1b./g, "");

  // Interpret backspace (\x08) the way a real terminal would: erase the
  // previously accumulated character instead of leaving it in the stream.
  let unwound = "";
  for (const ch of text) {
    if (ch === "\x08") {
      unwound = unwound.slice(0, -1);
    } else {
      unwound += ch;
    }
  }
  text = unwound;

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Strip remaining C0 control characters, keeping \n and \t
  text = text.replace(/[\x00-\x08\x0b-\x1f]/g, "");

  return text;
}

// Feed a raw stream chunk into an execution's logs, buffered by real newline
// boundaries instead of pushing one `logs` entry per raw TCP read. Some
// devices (character-at-a-time keystroke echo, chunked "--More--" paging,
// etc.) write output in small fragments that don't land on line breaks at
// all — pushing each fragment as its own `logs` entry rendered every
// fragment as a separate on-screen line (each entry is one block-level div
// in the UI), so a single logical line came out visually shredded across
// many rows. Instead, an in-progress line keeps growing in place until a
// real '\n' arrives to close it off; only then does further data start a
// new entry. Any *other* kind of log write (status messages, command
// echoes) always starts its own fresh entry and clears this buffering state
// first, so it never gets glued onto a dangling raw fragment.
function appendStreamChunk(execId: string, chunk: string) {
  if (!chunk) return;
  const currentExec = scriptExecutions.find(e => e.id === execId);
  if (!currentExec) return;

  const segments = chunk.split("\n");
  if (openStreamLineExecIds.has(execId) && currentExec.logs.length > 0) {
    currentExec.logs[currentExec.logs.length - 1] += segments[0];
  } else {
    currentExec.logs.push(segments[0]);
  }
  for (let i = 1; i < segments.length; i++) {
    currentExec.logs.push(segments[i]);
  }
  openStreamLineExecIds.add(execId);
}

// Run an interactive SSH shell session: connect, push each command in order
// (streaming whatever the device actually returns into the log), then — once
// every scripted command has been sent — keep the shell open and register it
// in `liveSessions` instead of closing it, so manual CLI commands can still
// be sent into the same live session afterwards.
function runSshExecution(
  execId: string,
  host: TerminalHost,
  script: CommandScript,
  appendLog: (text: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let settled = false; // whether the "commands dispatched" promise has settled
    let commandsDone = false; // whether we've finished sending scripted commands and kept the session open

    const settleOnce = (err?: any) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { conn.end(); } catch { /* already closed */ }
        reject(err);
      } else {
        resolve();
      }
    };

    // Called whenever the underlying stream/connection closes or errors,
    // whether that happens while commands are still being dispatched (a real
    // failure) or afterwards, while the session was being kept open for
    // manual CLI use (a normal/eventual disconnect).
    const handleSessionEnd = (err?: any) => {
      if (!commandsDone) {
        settleOnce(err || new Error("SSH 세션이 예기치 않게 종료되었습니다."));
        return;
      }
      if (!liveSessions.has(execId)) return; // already torn down explicitly
      const reason = err ? describeConnectionError(err, host) : `[${nowStr()}] [연결 종료] 원격 세션이 종료되었습니다.`;
      closeLiveSession(execId, `\n${reason}`);
      saveState();
    };

    conn.on("ready", () => {
      appendLog(`[${nowStr()}] SSH 인증 성공. 인터랙티브 셸을 여는 중...`);

      conn.shell((err, stream) => {
        if (err) return settleOnce(err);

        stream.on("data", (data: Buffer) => appendStreamChunk(execId, sanitizeTerminalOutput(data.toString())));
        stream.stderr?.on("data", (data: Buffer) => appendStreamChunk(execId, sanitizeTerminalOutput(data.toString())));
        stream.on("error", (streamErr: any) => handleSessionEnd(streamErr));
        stream.on("close", () => handleSessionEnd());

        (async () => {
          for (let i = 0; i < script.commands.length; i++) {
            const currentExec = scriptExecutions.find(e => e.id === execId);
            if (!currentExec || currentExec.status === "failed") break;

            const { cmd, waitMs, tagged } = parseDelayTag(script.commands[i]);
            currentExec.currentCommand = cmd;
            currentExec.progress = Math.floor((i / script.commands.length) * 100);

            // Wait first, then send — so a "<sN>" tag means "wait N seconds,
            // then send this command" rather than delaying the *next* one.
            await delay(waitMs);

            appendLog(`\n${host.name.split(" ")[0]}# ${cmd}${tagged ? `  (⏱ ${waitMs}ms 대기 후 전송)` : ''}`);
            stream.write(cmd + "\n");
          }

          // Keep the shell open instead of stream.end()/conn.end() so manual
          // CLI input can keep using this same live session.
          commandsDone = true;
          liveSessions.set(execId, {
            protocol: 'SSH',
            write: (data: string) => stream.write(data),
            close: () => {
              try { stream.end(); } catch { /* already closed */ }
              try { conn.end(); } catch { /* already closed */ }
            }
          });
          const currentExec = scriptExecutions.find(e => e.id === execId);
          if (currentExec) currentExec.sessionOpen = true;
          settleOnce();
        })().catch(loopErr => settleOnce(loopErr));
      });
    });

    conn.on("error", (err: any) => handleSessionEnd(err));

    conn.connect({
      host: host.ip,
      port: host.port,
      username: host.username,
      password: host.password,
      readyTimeout: 10000,
      tryKeyboard: true,
      // Older network gear (Cisco/Juniper switches, etc.) often only offers legacy
      // key exchange/cipher/host-key algorithms that ssh2 no longer enables by
      // default, causing "no matching key exchange algorithm" failures. Append the
      // legacy algorithms on top of ssh2's modern defaults so those devices can
      // still negotiate a session, without dropping the secure defaults for
      // devices that support them.
      algorithms: {
        kex: {
          append: [
            "diffie-hellman-group1-sha1",
            "diffie-hellman-group14-sha1",
            "diffie-hellman-group-exchange-sha1"
          ],
          prepend: [],
          remove: []
        },
        cipher: {
          append: ["aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc"],
          prepend: [],
          remove: []
        },
        serverHostKey: {
          append: ["ssh-rsa", "ssh-dss"],
          prepend: [],
          remove: []
        },
        hmac: {
          append: ["hmac-sha1", "hmac-md5"],
          prepend: [],
          remove: []
        }
      }
    });
  });
}

// Run a Telnet session using the same connect -> login -> sequential write
// pattern as the SSH path, streaming real device output into the log. Once
// every scripted command has been sent, the connection is kept open and
// registered in `liveSessions` (same rationale as runSshExecution above).
function runTelnetExecution(
  execId: string,
  host: TerminalHost,
  script: CommandScript,
  appendLog: (text: string) => void
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const connection = new Telnet();
    let settled = false;
    let commandsDone = false;

    const settleOnce = (err?: any) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const handleSessionEnd = (err?: any) => {
      if (!commandsDone) {
        settleOnce(err || new Error("TELNET 세션이 예기치 않게 종료되었습니다."));
        return;
      }
      if (!liveSessions.has(execId)) return; // already torn down explicitly
      const reason = err ? describeConnectionError(err, host) : `[${nowStr()}] [연결 종료] 원격 세션이 종료되었습니다.`;
      closeLiveSession(execId, `\n${reason}`);
      saveState();
    };

    connection.on("data", (data: Buffer) => appendStreamChunk(execId, sanitizeTerminalOutput(data.toString())));
    // Registering these before connect() also prevents Node from throwing on
    // an unhandled 'error' event once the connection is kept open past the
    // initial connect() call.
    connection.on("error", (err: any) => handleSessionEnd(err));
    connection.on("close", () => handleSessionEnd());

    // A host registered with no account info (no password — see the
    // /api/hosts routes) must skip telnet-client's automatic login handshake
    // entirely, so the device's own login/password prompt flows through as
    // plain output for the script's commands to answer directly (exactly
    // like a human typing into a raw telnet client) instead of the library
    // intercepting it.
    //
    // IMPORTANT: this is NOT achieved by simply omitting username/password/
    // shellPrompt from the options below. telnet-client's defaultOptions
    // ships non-empty fallbacks for all of them (username 'root', password
    // 'guest', shellPrompt /(?:\/ )?#\s/, loginPrompt /login[: ]*$/i,
    // passwordPrompt /password[: ]*$/i) which Object.assign onto its
    // internal opts, so an omitted key silently leaves that default active
    // — confirmed by testing: omitting them still made the library try to
    // auto-answer a "Password:" prompt with the literal string 'guest'.
    // The actual, verified way to disable it is to pass an *explicitly
    // falsy* `shellPrompt`. telnet-client's `socket.on('connect', ...)`
    // handler checks `if (!this.opts.shellPrompt)` and, if so, immediately
    // sets its internal state to 'standby' before any data has arrived.
    // Once in 'standby', its parseData() login-detection branch (which only
    // runs in state 'getprompt') can never run again for the rest of the
    // session, so every byte the device sends is just forwarded as-is and
    // username/password/loginPrompt/passwordPrompt become irrelevant (kept
    // here as an unmatchable regex purely as defense in depth, in case a
    // future telnet-client version changes this internal detail).
    const hasCredentials = !!host.password;
    const NEVER_MATCH = /(?!)/;
    try {
      await connection.connect({
        host: host.ip,
        port: host.port,
        timeout: 10000,
        ...(hasCredentials ? {
          username: host.username,
          password: host.password,
          shellPrompt: /[$%#>]\s*$/,
          loginPrompt: /login[: ]*$/i,
          passwordPrompt: /password[: ]*$/i,
          failedLoginMatch: /(?:incorrect|failed|denied|invalid)/i,
        } : {
          shellPrompt: false as unknown as RegExp,
          loginPrompt: NEVER_MATCH,
          passwordPrompt: NEVER_MATCH,
          failedLoginMatch: NEVER_MATCH,
        }),
        // IMPORTANT: must stay true (the telnet-client default). When false,
        // connect() resolves the instant the raw TCP socket connects instead
        // of waiting for the login/password handshake to actually finish
        // (telnet-client still negotiates login in the background, but the
        // returned promise no longer waits for it). That let this function
        // start writing the *scripted* commands while the device was still
        // sitting at its login/password prompts, so the first one or two
        // script commands were silently consumed as the username/password
        // instead of being executed, and the device's real replies to them
        // never made it into the log in the right place. Keeping this true
        // makes connect() only resolve once the shell prompt is actually
        // reached, so every scripted command is guaranteed to be sent one at
        // a time to a fully logged-in shell. (When hasCredentials is false,
        // this has no effect either way — see the shellPrompt note above.)
        negotiationMandatory: true
      });
    } catch (err) {
      settleOnce(err);
      return;
    }

    appendLog(
      hasCredentials
        ? `[${nowStr()}] TELNET 인증 성공. 명령 실행을 시작합니다...`
        : `[${nowStr()}] TELNET 연결 성공 (등록된 계정 정보 없음 — 자동 로그인 없이 원본 연결만 열었습니다). 명령 실행을 시작합니다...`
    );

    try {
      const socket = connection.getSocket();
      if (!socket || !socket.writable) {
        throw new Error("telnet socket not writable");
      }

      for (let i = 0; i < script.commands.length; i++) {
        const currentExec = scriptExecutions.find(e => e.id === execId);
        if (!currentExec || currentExec.status === "failed") break;

        const { cmd, waitMs, tagged } = parseDelayTag(script.commands[i]);
        currentExec.currentCommand = cmd;
        currentExec.progress = Math.floor((i / script.commands.length) * 100);

        // Wait first, then send — mirrors runSshExecution above so both
        // protocols treat "<sN>" identically (wait N seconds, then send).
        await delay(waitMs);

        appendLog(`\n${host.name.split(" ")[0]}# ${cmd}${tagged ? `  (⏱ ${waitMs}ms 대기 후 전송)` : ''}`);
        socket.write(cmd + "\n");
      }

      // Keep the connection open instead of connection.end() so manual CLI
      // input can keep using this same live session.
      commandsDone = true;
      liveSessions.set(execId, {
        protocol: 'TELNET',
        write: (data: string) => socket.write(data),
        close: () => { try { connection.end(); } catch { /* already closed */ } }
      });
      const currentExec = scriptExecutions.find(e => e.id === execId);
      if (currentExec) currentExec.sessionOpen = true;
      settleOnce();
    } catch (err) {
      settleOnce(err);
    }
  });
}

async function runScriptExecution(execId: string, host: TerminalHost, script: CommandScript) {
  const appendLog = (text: string) => {
    const currentExec = scriptExecutions.find(e => e.id === execId);
    if (currentExec) currentExec.logs.push(text);
    openStreamLineExecIds.delete(execId);
  };

  // SSH authenticates as part of the protocol handshake itself, so there's no
  // way to reach a shell without valid credentials — unlike TELNET, a script
  // can't "type" a username/password into an SSH session that never
  // authenticated in the first place. A password-less TELNET host is allowed
  // through: runTelnetExecution below skips the automatic login entirely and
  // just opens the raw connection, so the script's own commands can answer
  // whatever login/password prompt the device shows.
  if (!host.password && host.protocol === "SSH") {
    appendLog(`[${nowStr()}] [오류] SSH는 등록된 비밀번호 없이는 접속할 수 없습니다. 호스트에 계정 정보를 등록하세요.`);
    const currentExec = scriptExecutions.find(e => e.id === execId);
    if (currentExec) {
      currentExec.status = "failed";
      currentExec.sessionOpen = false;
    }
    saveState();
    return;
  }

  try {
    if (host.protocol === "SSH") {
      await runSshExecution(execId, host, script, appendLog);
    } else {
      await runTelnetExecution(execId, host, script, appendLog);
    }

    const currentExec = scriptExecutions.find(e => e.id === execId);
    if (currentExec && currentExec.status !== "failed") {
      currentExec.status = "completed";
      currentExec.progress = 100;
      if (script.commands.length > 0) {
        appendLog(`\n[${nowStr()}] --- SCRIPT SUCCESS: All ${script.commands.length} automation tasks finished successfully ---`);
      } else {
        appendLog(`\n[${nowStr()}] --- 수동 접속 성공 ---`);
      }
      // The connection is intentionally kept open (registered in
      // liveSessions) so manual CLI commands can still be sent afterwards.
      appendLog(`[${nowStr()}] 세션이 유지됩니다. 아래 입력창으로 수동 명령을 계속 전송할 수 있습니다.`);
    }
  } catch (err: any) {
    const currentExec = scriptExecutions.find(e => e.id === execId);
    if (currentExec) {
      currentExec.status = "failed";
      currentExec.sessionOpen = false;
      appendLog(`\n${describeConnectionError(err, host)}`);
    }
  } finally {
    saveState();
  }
}

app.post("/api/scripts/execute", (req, res) => {
  const { hostId, scriptId } = req.body;
  const host = terminalHosts.find(h => h.id === hostId);
  const script = commandScripts.find(s => s.id === scriptId);

  if (!host || !script) {
    return res.status(404).json({ error: "Host or Script not found" });
  }

  const execId = "exec-" + Date.now();
  const initialLogs = [
    `[${nowStr()}] ${host.protocol} 접속을 시도합니다: ${host.ip}:${host.port} (${host.username ? `사용자: ${host.username}` : "계정 정보 없음"})...`
  ];

  const execution: ScriptExecution = {
    id: execId,
    hostId,
    scriptId,
    status: 'running',
    currentCommand: script.commands[0],
    progress: 0,
    logs: initialLogs,
    timestamp: new Date().toISOString(),
    sessionOpen: false
  };

  scriptExecutions.push(execution);
  saveState();

  // Fire and forget: the real session runs in the background while the
  // frontend polls /api/scripts/executions for progress and log updates.
  runScriptExecution(execId, host, script).catch(err => {
    console.error(`Script execution ${execId} failed unexpectedly`, err);
  });

  res.json({ success: true, executionId: execId });
});

app.get("/api/scripts/executions", (req, res) => {
  res.json({ scriptExecutions });
});

app.get("/api/scripts/executions/:id", (req, res) => {
  const exec = scriptExecutions.find(e => e.id === req.params.id);
  if (!exec) return res.status(404).json({ error: "Execution log not found" });
  res.json({ execution: exec });
});

// Fully close a single session tab: tear down the live connection (if any),
// then drop the execution record entirely so it disappears from the tab
// list. Distinct from POST /api/terminal/disconnect, which only severs the
// live connection but keeps the execution record (and its tab) around.
app.delete("/api/scripts/executions/:id", (req, res) => {
  const execId = req.params.id;
  const exists = scriptExecutions.some(e => e.id === execId);
  if (!exists) {
    return res.status(404).json({ error: "Execution log not found" });
  }

  if (liveSessions.has(execId)) {
    closeLiveSession(execId, `\n[${nowStr()}] [세션 닫기] 사용자 요청으로 세션을 닫았습니다.`);
  }

  scriptExecutions = scriptExecutions.filter(e => e.id !== execId);
  saveState();
  res.json({ success: true, scriptExecutions });
});

// Fully close every session tab at once: tear down any still-open live
// connections, then clear the execution list entirely.
app.post("/api/scripts/executions/close-all", (req, res) => {
  for (const execId of Array.from(liveSessions.keys())) {
    if (scriptExecutions.some(e => e.id === execId)) {
      closeLiveSession(execId, `\n[${nowStr()}] [세션 닫기] 사용자 요청으로 세션을 닫았습니다.`);
    }
  }

  scriptExecutions = [];
  saveState();
  res.json({ success: true, scriptExecutions });
});

// Manual-connect: open a live SSH/Telnet session against a saved device
// profile without running any scripted commands. Reuses the exact same
// connect/auth machinery as batch script execution (runScriptExecution with
// an empty command list), so error handling/messages stay consistent.
app.post("/api/terminal/connect", (req, res) => {
  const { hostId } = req.body;
  const host = terminalHosts.find(h => h.id === hostId);

  if (!host) {
    return res.status(404).json({ error: "Host not found" });
  }

  const execId = "exec-" + Date.now();
  const manualScript: CommandScript = { id: "manual", name: "수동 연결", description: "", commands: [] };
  const initialLogs = [
    `[${nowStr()}] ${host.protocol} 수동 접속을 시도합니다: ${host.ip}:${host.port} (${host.username ? `사용자: ${host.username}` : "계정 정보 없음"})...`
  ];

  const execution: ScriptExecution = {
    id: execId,
    hostId,
    scriptId: "manual",
    status: 'running',
    currentCommand: '',
    progress: 0,
    logs: initialLogs,
    timestamp: new Date().toISOString(),
    sessionOpen: false
  };

  scriptExecutions.push(execution);
  saveState();

  runScriptExecution(execId, host, manualScript).catch(err => {
    console.error(`Manual connect ${execId} failed unexpectedly`, err);
  });

  res.json({ success: true, executionId: execId });
});

// Send a manual CLI command into one or more already-open live sessions at
// once. A single execId behaves like "send to this session"; multiple
// execIds behave like SecureCRT's "send to all sessions" broadcast. Sessions
// that are missing/closed are reported individually in `errors` without
// blocking delivery to the remaining valid sessions (partial success).
app.post("/api/terminal/send", (req, res) => {
  const { execIds, command } = req.body;
  if (!Array.isArray(execIds) || execIds.length === 0 || typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ error: "execIds 배열과 command가 필요합니다." });
  }

  const errors: { execId: string; error: string }[] = [];
  let sentCount = 0;

  for (const execId of execIds) {
    const session = liveSessions.get(execId);
    const currentExec = scriptExecutions.find(e => e.id === execId);
    if (!session || !currentExec || !currentExec.sessionOpen) {
      errors.push({ execId, error: "세션이 열려 있지 않습니다." });
      continue;
    }
    try {
      currentExec.logs.push(`\nManual_CLI# ${command}`);
      openStreamLineExecIds.delete(execId);
      session.write(command + "\n");
      sentCount++;
    } catch (err: any) {
      errors.push({ execId, error: err?.message || String(err) });
    }
  }

  saveState();
  res.json({ success: sentCount > 0, sentCount, errors });
});

// Explicitly close a live session (e.g. user clicks "연결 종료" on a tab).
app.post("/api/terminal/disconnect", (req, res) => {
  const { execId } = req.body;
  const currentExec = scriptExecutions.find(e => e.id === execId);
  if (!currentExec) {
    return res.status(404).json({ error: "Execution not found" });
  }

  if (liveSessions.has(execId)) {
    closeLiveSession(execId, `\n[${nowStr()}] [연결 종료] 사용자 요청으로 연결을 종료했습니다.`);
  } else {
    currentExec.sessionOpen = false;
  }

  saveState();
  res.json({ success: true, execution: currentExec });
});

// Open a brand-new, short-lived SSH/Telnet connection to a registered device
// purely to run "show cdp neighbors detail" / "show lldp neighbors detail"
// and capture the raw output, then close it immediately. Deliberately
// independent of `liveSessions` — it must never disturb an existing live
// session the user has open for this same host. There's no raw packet
// capture involved (this app ships as a pkg-packaged exe with no native
// addons), so CDP/LLDP data is read the same way a human would: log in and
// run the standard Cisco-style show commands.
function queryNeighborInfo(host: TerminalHost): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!host.password) {
    return Promise.resolve({ success: false, error: "이 호스트에 등록된 비밀번호가 없어 접속할 수 없습니다." });
  }

  if (host.protocol === "SSH") {
    return new Promise((resolve) => {
      const conn = new SshClient();
      let output = "";
      let settled = false;
      const finish = (result: { success: boolean; output?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* already closed */ }
        resolve(result);
      };

      conn.on("ready", () => {
        conn.shell((err, stream) => {
          if (err) {
            finish({ success: false, error: describeConnectionError(err, host) });
            return;
          }
          stream.on("data", (data: Buffer) => { output += sanitizeTerminalOutput(data.toString()); });
          stream.stderr?.on("data", (data: Buffer) => { output += sanitizeTerminalOutput(data.toString()); });
          stream.on("error", (streamErr: any) => finish({ success: false, error: describeConnectionError(streamErr, host) }));

          stream.write("terminal length 0\n");
          setTimeout(() => stream.write("show cdp neighbors detail\n"), 500);
          setTimeout(() => stream.write("show lldp neighbors detail\n"), 2500);
          // Extreme Networks (EXOS) switches don't recognize the "detail"
          // keyword on this command — their plain "show lldp neighbors"
          // (no "detail") is what actually returns neighbor info there.
          // Harmless no-op/error echo on Cisco-style gear, same as the two
          // commands above are on devices that don't support them.
          setTimeout(() => stream.write("show lldp neighbors\n"), 4500);
          setTimeout(() => finish({ success: true, output }), 7000);
        });
      });

      conn.on("error", (err: any) => finish({ success: false, error: describeConnectionError(err, host) }));

      conn.connect({
        host: host.ip,
        port: host.port,
        username: host.username,
        password: host.password,
        readyTimeout: 10000,
        tryKeyboard: true,
        // Same legacy-algorithm allowances as runSshExecution, for older
        // network gear that doesn't offer ssh2's modern defaults.
        algorithms: {
          kex: {
            append: [
              "diffie-hellman-group1-sha1",
              "diffie-hellman-group14-sha1",
              "diffie-hellman-group-exchange-sha1"
            ],
            prepend: [],
            remove: []
          },
          cipher: {
            append: ["aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc"],
            prepend: [],
            remove: []
          },
          serverHostKey: {
            append: ["ssh-rsa", "ssh-dss"],
            prepend: [],
            remove: []
          },
          hmac: {
            append: ["hmac-sha1", "hmac-md5"],
            prepend: [],
            remove: []
          }
        }
      });
    });
  }

  // TELNET path
  return (async () => {
    const connection = new Telnet();
    let output = "";
    connection.on("data", (data: Buffer) => { output += sanitizeTerminalOutput(data.toString()); });

    try {
      await connection.connect({
        host: host.ip,
        port: host.port,
        username: host.username,
        password: host.password,
        timeout: 10000,
        shellPrompt: /[$%#>]\s*$/,
        loginPrompt: /login[: ]*$/i,
        passwordPrompt: /password[: ]*$/i,
        failedLoginMatch: /(?:incorrect|failed|denied|invalid)/i,
        negotiationMandatory: true
      });
    } catch (err: any) {
      return { success: false, error: describeConnectionError(err, host) };
    }

    try {
      const socket = connection.getSocket();
      if (!socket || !socket.writable) {
        throw new Error("telnet socket not writable");
      }
      socket.write("terminal length 0\n");
      await delay(500);
      socket.write("show cdp neighbors detail\n");
      await delay(2000);
      socket.write("show lldp neighbors detail\n");
      await delay(2000);
      // Extreme Networks (EXOS) switches don't recognize the "detail"
      // keyword on this command — their plain "show lldp neighbors" (no
      // "detail") is what actually returns neighbor info there. Harmless
      // no-op/error echo on Cisco-style gear, same as the two commands
      // above are on devices that don't support them.
      socket.write("show lldp neighbors\n");
      await delay(2500);
    } catch (err: any) {
      try { connection.end(); } catch { /* already closed */ }
      return { success: false, error: describeConnectionError(err, host) };
    }

    try { connection.end(); } catch { /* already closed */ }
    return { success: true, output };
  })();
}

// CDP/LLDP neighbor lookup: SSH/Telnet into the device with a fresh,
// temporary connection (never touches an existing liveSessions entry) and
// return the raw output of "show cdp neighbors detail", "show lldp
// neighbors detail", and "show lldp neighbors" (the last one specifically
// for Extreme Networks/EXOS gear, which doesn't accept "detail" on that
// command). Non-network devices (plain PCs/servers) and switches that don't
// support a given command will typically just echo back "command not
// found"-style output for it, which is expected and not treated as a
// request failure.
//
// Accepts either a registered TerminalHost (via `hostId`) or an ad-hoc,
// one-off set of connection details (`ip`/`port`/`protocol`/`username`/
// `password`) for a device that isn't registered as a TerminalHost — e.g.
// a DHCP lease the user wants to query without first adding it as an
// automation target. The ad-hoc credentials are never persisted to
// `terminalHosts`; they only live for the duration of this single request.
app.post("/api/terminal/neighbors", async (req, res) => {
  const { hostId, ip, port, protocol, username, password } = req.body;

  let host: TerminalHost | undefined;
  if (hostId) {
    host = terminalHosts.find(h => h.id === hostId);
    if (!host) {
      return res.status(404).json({ error: "Host not found" });
    }
  } else {
    if (!ip || !username) {
      return res.status(400).json({ error: "ip와 username이 필요합니다." });
    }
    const adhocProtocol: 'SSH' | 'TELNET' = protocol === "TELNET" ? "TELNET" : "SSH";
    host = {
      id: "adhoc",
      name: ip,
      ip,
      port: Number(port) || (adhocProtocol === "TELNET" ? 23 : 22),
      protocol: adhocProtocol,
      username,
      password
    };
  }

  const result = await queryNeighborInfo(host);
  res.json(result);
});


// System Settings & Recovery
app.post("/api/system/config", (req, res) => {
  const { autoStart } = req.body;
  if (autoStart !== undefined) {
    systemStatus.autoStart = autoStart;
  }
  saveState();
  res.json({ success: true, systemStatus });
});

app.post("/api/system/reset", async (req, res) => {
  // Clear persistent file state. Both files are deleted outright (not just
  // overwritten via the saveState() call below) so a factory reset leaves no
  // on-disk trace of the wiped account even if the ini rewrite step were to
  // fail — setting.ini is a full independent copy of webAuth (password hash
  // + salt included), so leaving a stale copy behind after "resetting" would
  // defeat the point of the reset.
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
  if (fs.existsSync(SETTINGS_FILE)) {
    fs.unlinkSync(SETTINGS_FILE);
  }

  // Actually stop any real running engines — otherwise the status flags below
  // would say "off" while DHCP/TFTP/FTP kept running for real in the background.
  stopDhcpServer();
  stopTftpServer();
  await stopFtpServer();

  // Clear variables to empty states
  systemStatus = {
    dhcpRunning: false,
    tftpRunning: false,
    ftpRunning: false,
    autoStart: true,
    cpuUsage: 0.0,
    memoryUsage: 0.0,
    uptime: 0
  };
  leases = [];
  reservations = [];
  tftpFtpConfig = {
    tftpEnabled: false,
    ftpEnabled: false,
    rootFolder: SERVED_FOLDER,
    tftpPort: 69,
    ftpPort: 21
  };
  ftpCredentials = [];
  transferLogs = [];
  terminalHosts = [];
  commandScripts = [];
  // Factory reset wipes the admin account too, same as a router reset —
  // every session (including the one making this very request) ends, and
  // the next page load must go through account setup again.
  webAuth = null;
  webSessions.clear();
  dhcpConsoleLogs = [
    { timestamp: new Date().toISOString(), level: 'INFO', message: "System configurations factory reset by administrator." }
  ];
  // Close any still-open terminal sessions before dropping their execution records.
  for (const execId of Array.from(liveSessions.keys())) {
    closeLiveSession(execId);
  }
  scriptExecutions = [];

  saveState();
  res.json({ success: true, message: "System reset to factory defaults successfully." });
});

app.post("/api/system/restart", (req, res) => {
  // Respond immediately so the frontend sees the acknowledgement before the
  // current process tears itself down.
  res.json({ success: true, message: "서비스를 재시작합니다..." });

  setTimeout(() => {
    // A pkg-packaged exe has process.execPath pointing at the exe itself, so
    // relaunching with no args re-runs the whole bundled app. In dev/`npm start`,
    // process.execPath is the node/tsx binary, so the original entrypoint args
    // (process.argv.slice(1)) must be passed along to relaunch the same script.
    // execArgv must also be preserved in dev: tsx registers itself via
    // --require/--import node flags (not visible in argv), and without them a
    // bare `node server.ts` relaunch fails immediately since node can't parse TS.
    const isPackaged = !!(process as any).pkg;
    const relaunchArgs = isPackaged
      ? []
      : [...process.execArgv, ...process.argv.slice(1)];
    const child = spawn(process.execPath, relaunchArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.exit(0);
  }, 500);
});


// Standard full-stack SPA serving & dev logic
async function startServer() {
  // A pkg-packaged exe has no Vite dev toolchain available at runtime, so it must
  // always serve the pre-built static files regardless of NODE_ENV (which is unset
  // when a user just double-clicks the exe from Explorer).
  const isPackaged = !!(process as any).pkg;
  if (!isPackaged && process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // If packaged by pkg, the static files are bundled inside the snapshot folder.
    // In pkg, server.cjs is bundled inside and __dirname points to its packaged folder,
    // which contains the index.html and assets directly.
    const distPath = isPackaged
      ? path.join(scriptDirname)
      : path.join(process.cwd(), "dist");
      
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Network Server Suite] Backend running on port ${PORT}`);
  });

  // loadState()'s autoStart block (above) only sets systemStatus.tftpRunning/
  // ftpRunning flags — it can't call the real start functions itself since
  // they're defined later in this file. Actually bind the real engines here
  // so a restored "was running" state means the server is really running
  // again, not just showing a green dot. (DHCP intentionally excluded: its
  // real-network-conflict risk is meant to require the user to consciously
  // re-confirm via the UI toggle each time, not silently rebind on boot.)
  if (systemStatus.tftpRunning) {
    const result = await startTftpServer();
    if (!result.success) {
      systemStatus.tftpRunning = false;
      tftpFtpConfig.tftpEnabled = false;
      logDhcp('WARN', result.error || "TFTP 자동 시작에 실패했습니다.");
    }
  }
  if (systemStatus.ftpRunning) {
    const result = await startFtpServer();
    if (!result.success) {
      systemStatus.ftpRunning = false;
      tftpFtpConfig.ftpEnabled = false;
      logDhcp('WARN', result.error || "FTP 자동 시작에 실패했습니다.");
    }
  }
}

// Best-effort cleanup of any still-open SSH/Telnet terminal sessions on exit.
process.on("exit", () => {
  for (const session of liveSessions.values()) {
    try { session.close(); } catch { /* ignore */ }
  }
});

startServer();
