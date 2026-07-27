import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import dns from "dns";
import dgram from "dgram";
import { exec, execFile, spawn } from "child_process";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { Client as SshClient } from "ssh2";
import { Telnet } from "telnet-client";
import {
  DhcpConfig,
  DhcpLease, 
  DhcpReservation, 
  TftpFtpConfig, 
  TransferLog, 
  TerminalHost, 
  CommandScript, 
  ScriptExecution,
  SystemStatus
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

// This app IS the DHCP server, so the gateway it hands out to clients must be its
// own real interface IP — not a guessed "x.x.x.1". Range/subnet mask are derived
// from that same real adapter so they always describe a subnet this host is on.
function getSubnetDefaults(hostInfo: { ip: string; netmask: string }) {
  const parts = hostInfo.ip.split(".");
  const subnetBase = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return {
    rangeStart: `${subnetBase}.100`,
    rangeEnd: `${subnetBase}.200`,
    subnetMask: hostInfo.netmask || "255.255.255.0",
    gateway: hostInfo.ip
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
  leaseTime: 120 // minutes
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

let transferLogs: TransferLog[] = [];
let terminalHosts: TerminalHost[] = [];
let commandScripts: CommandScript[] = [];
let scriptExecutions: ScriptExecution[] = [];

// Clean standard boot log
let dhcpConsoleLogs: { timestamp: string; level: 'INFO' | 'SUCCESS' | 'WARN'; message: string }[] = [
  { timestamp: new Date().toISOString(), level: 'INFO', message: 'DHCP service initialized.' }
];

// Load state from file (Fulfills system recovery and automatic starting configuration)
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.systemStatus) systemStatus = { ...systemStatus, ...data.systemStatus };
      if (data.dhcpConfig) dhcpConfig = { ...dhcpConfig, ...data.dhcpConfig };
      if (data.leases) leases = data.leases;
      if (data.reservations) reservations = data.reservations;
      if (data.tftpFtpConfig) tftpFtpConfig = { ...tftpFtpConfig, ...data.tftpFtpConfig };
      if (data.transferLogs) transferLogs = data.transferLogs;
      if (data.terminalHosts) terminalHosts = data.terminalHosts;
      if (data.commandScripts) commandScripts = data.commandScripts;
      if (data.dhcpConsoleLogs) dhcpConsoleLogs = data.dhcpConsoleLogs;
      
      console.log("State restored successfully. AutoStart checks initiating...");
      
      // Auto-start services if they were running or if configured to always run on boot
      if (systemStatus.autoStart) {
        systemStatus.dhcpRunning = true;
        systemStatus.tftpRunning = true;
        systemStatus.ftpRunning = true;
        tftpFtpConfig.tftpEnabled = true;
        tftpFtpConfig.ftpEnabled = true;
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'SUCCESS',
          message: 'System recovered from restart. Auto-started DHCP Server.'
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
      transferLogs,
      terminalHosts,
      commandScripts,
      dhcpConsoleLogs
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save state", error);
  }
}

// Initial load
loadState();

// A persisted config may reference an adapter name from a previous run (or a
// different PC entirely) that doesn't exist on this host anymore, or may carry
// stale range/gateway values from before those were derived from the real adapter
// (or from before this host's IP changed, e.g. a DHCP lease renewal from the real
// router). Self-heal both instead of silently keeping phantom network settings.
// Returns true if the config was changed.
function ensureDhcpConfigMatchesHost(): boolean {
  let healInterfaceName = dhcpConfig.interfaceName;
  let healHostInfo = getInterfaceInfo(healInterfaceName);
  const fellBackToDefaultInterface = !healHostInfo;
  if (!healHostInfo) {
    healInterfaceName = getDefaultInterfaceName();
    healHostInfo = healInterfaceName ? getInterfaceInfo(healInterfaceName) : null;
  }
  if (!healHostInfo) return false;

  // The adapter can be legitimately stuck in APIPA (169.254.x.x) while the admin
  // has already saved a real gateway in the DHCP Pool config — that's exactly the
  // transient state /api/dhcp/toggle's netsh auto-fix step is meant to resolve, by
  // pushing dhcpConfig.gateway onto the adapter. If we self-heal here first, we'd
  // silently overwrite the admin's saved config with the adapter's throwaway APIPA
  // address before netsh ever gets a chance to run, turning a normal "adapter
  // hasn't been assigned yet" moment into permanent data loss. So: only self-heal
  // on an APIPA host if we also had to fall back to a different adapter entirely
  // (i.e. the persisted interfaceName is stale/from another host) — a saved,
  // still-valid non-APIPA gateway for the *same* adapter is left alone.
  const hostIsApipa = healHostInfo.ip.startsWith("169.254.");
  const configGatewayIsValid = isValidIPv4(dhcpConfig.gateway) && !dhcpConfig.gateway.startsWith("169.254.");
  if (hostIsApipa && configGatewayIsValid && !fellBackToDefaultInterface) {
    return false;
  }

  if (dhcpConfig.gateway !== healHostInfo.ip) {
    dhcpConfig = {
      ...dhcpConfig,
      interfaceName: healInterfaceName,
      ...getSubnetDefaults(healHostInfo)
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

function isIpInRange(ip: string, start: string, end: string): boolean {
  const n = ipToInt(ip);
  return n >= ipToInt(start) && n <= ipToInt(end);
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
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
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

function findAvailableIp(): string | null {
  const start = ipToInt(dhcpConfig.rangeStart);
  const end = ipToInt(dhcpConfig.rangeEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null;
  const usedIps = new Set(leases.filter(l => l.status !== 'expired').map(l => l.ip));
  const reservedIps = new Set(reservations.map(r => r.ip));
  for (let cur = start; cur <= end; cur++) {
    const candidate = intToIp(cur);
    if (!usedIps.has(candidate) && !reservedIps.has(candidate)) return candidate;
  }
  return null;
}

// Add/update the single lease record for a MAC. This *is* the server's
// internal lease-tracking structure — there is no separate table — so
// deleting an entry from `leases` (e.g. via DELETE /api/dhcp/leases/:id)
// immediately makes that IP available again through findAvailableIp().
function upsertLease(mac: string, ip: string, hostname: string, status: 'active' | 'reserved'): DhcpLease {
  const now = Date.now();
  const idx = leases.findIndex(l => l.mac === mac && l.id !== 'host-pc-self');
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
  const reservation = reservations.find(r => r.mac.toUpperCase() === mac);
  let offerIp: string | undefined = reservation?.ip;
  if (!offerIp) {
    const existing = leases.find(l => l.mac === mac && l.status !== 'expired' && l.id !== 'host-pc-self');
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
  const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
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

  const reservation = reservations.find(r => r.mac.toUpperCase() === mac);
  const isReservedForThisMac = !!reservation && reservation.ip === requestedIp;
  const inRange = isIpInRange(requestedIp, dhcpConfig.rangeStart, dhcpConfig.rangeEnd);
  const conflict = leases.find(l => l.ip === requestedIp && l.mac !== mac && l.status !== 'expired');

  if (conflict || (!inRange && !isReservedForThisMac)) {
    logDhcp('WARN', `DHCPREQUEST 거부: MAC ${mac} 가 요청한 IP ${requestedIp} 는 할당할 수 없어 DHCPNAK 전송`);
    sendDhcpReply(6, pkt, requestedIp);
    return;
  }

  const hostnameOpt = pkt.options.get(12);
  const hostname = (hostnameOpt ? hostnameOpt.toString("utf8").replace(/[^\x20-\x7e]/g, "").trim() : "") || `Device-${requestedIp.split(".")[3]}`;

  upsertLease(mac, requestedIp, hostname, isReservedForThisMac ? 'reserved' : 'active');
  logDhcp('SUCCESS', `DHCPREQUEST 수신: MAC ${mac} → DHCPACK ${requestedIp} 전송 (${hostname}, ${dhcpConfig.leaseTime}분 임대)`);
  sendDhcpReply(5, pkt, requestedIp);
  saveState();
}

function handleDhcpRelease(pkt: ParsedDhcpPacket) {
  const mac = pkt.chaddr;
  const idx = leases.findIndex(l => l.mac === mac && l.id !== 'host-pc-self' && l.status !== 'reserved');
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

    const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
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
          const currentHost = getInterfaceInfo(dhcpConfig.interfaceName);
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

  // Reclaim expired dynamic leases so their IPs become available again.
  if (systemStatus.dhcpRunning) {
    expireLeases();
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


/* --- SYSTEM API ENDPOINTS --- */

app.get("/api/status", (req, res) => {
  res.json({
    systemStatus,
    dhcpConfig,
    leases,
    reservations,
    tftpFtpConfig,
    transferLogs,
    terminalHosts,
    commandScripts,
    dhcpConsoleLogs
  });
});

app.post("/api/system/console-log/clear", (req, res) => {
  dhcpConsoleLogs = [];
  saveState();
  res.json({ success: true, dhcpConsoleLogs });
});

// Helper to extract IP and MAC from selected interface name.
// Returns null when the adapter can't be found on this host — callers must handle
// that explicitly instead of silently falling back to fabricated data.
function getInterfaceInfo(name: string): { ip: string; mac: string; netmask: string } | null {
  try {
    const nets = os.networkInterfaces();
    const infos = nets[name];
    if (infos) {
      let ipv4 = infos.find(info => info.family === "IPv4" && !info.internal);
      if (!ipv4) ipv4 = infos.find(info => info.family === "IPv4");
      if (ipv4) {
        return {
          ip: ipv4.address,
          mac: ipv4.mac || "00:00:00:00:00:00",
          netmask: ipv4.netmask
        };
      }
    }
  } catch (e) {
    console.error("Error reading interface details", e);
  }
  return null;
}

function isValidIPv4(ip: string): boolean {
  if (!ip) return false;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Force the given adapter to a static IP via Windows `netsh`. Used when the
// adapter is stuck in APIPA (169.254.x.x, i.e. no upstream DHCP server ever
// assigned it a real address) — this app IS the DHCP server for the LAN, so it
// must put its own gateway IP on the adapter itself rather than handing out a
// 169.254.x.x gateway to the clients it serves. Requires admin rights (the app
// already requires them to bind UDP port 67 for the DHCP engine itself).
function assignStaticIpViaNetsh(interfaceName: string, ip: string, subnetMask: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!isValidIPv4(ip) || !isValidIPv4(subnetMask)) {
      resolve({ success: false, error: "게이트웨이 IP 또는 서브넷 마스크 형식이 올바르지 않습니다." });
      return;
    }
    // execFile (no shell) instead of exec — args are passed straight to the
    // process, never interpreted for shell metacharacters, so a malformed or
    // hostile subnetMask/interfaceName value can't break out into arbitrary
    // command execution.
    execFile(
      "netsh",
      ["interface", "ip", "set", "address", `name=${interfaceName}`, "static", ip, subnetMask],
      (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: (stderr && stderr.trim()) || error.message });
        } else {
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
    const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);

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
        systemStatus, dhcpConfig, leases, dhcpConsoleLogs
      });
    }

    // If the adapter is set to "obtain IP automatically" and there is no real
    // upstream DHCP server on the LAN, Windows self-assigns an APIPA address
    // (169.254.x.x). Since this app IS the DHCP server, handing that out as the
    // gateway to clients would be a serious misconfiguration — force the adapter
    // to a real static IP (this DHCP Pool's own configured gateway/mask) first.
    if (hostInfo.ip.startsWith("169.254.")) {
      if (!isValidIPv4(dhcpConfig.gateway) || dhcpConfig.gateway.startsWith("169.254.")) {
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `어댑터가 APIPA(${hostInfo.ip}) 상태이지만 DHCP Pool 설정의 게이트웨이(${dhcpConfig.gateway || '미지정'})가 유효하지 않아 자동 조치를 진행할 수 없습니다.`
        });
        saveState();
        return res.json({
          success: false,
          error: "DHCP Pool 설정에서 유효한 게이트웨이 IP를 먼저 지정하세요 (169.254 대역 불가).",
          systemStatus, dhcpConfig, leases, dhcpConsoleLogs
        });
      }

      const netshResult = await assignStaticIpViaNetsh(dhcpConfig.interfaceName, dhcpConfig.gateway, dhcpConfig.subnetMask);
      if (!netshResult.success) {
        systemStatus.dhcpRunning = false;
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `[자동 조치 실패] 어댑터를 고정 IP(${dhcpConfig.gateway})로 설정하지 못했습니다: ${netshResult.error || '알 수 없는 오류'} (관리자 권한으로 실행 중인지 확인하세요)`
        });
        saveState();
        return res.json({
          success: false,
          error: `어댑터를 고정 IP로 설정하지 못했습니다: ${netshResult.error || '알 수 없는 오류'}`,
          systemStatus, dhcpConfig, leases, dhcpConsoleLogs
        });
      }

      // Windows may take a moment to actually apply the new address — poll a
      // few times instead of assuming it's instantaneous, but proceed either way.
      let confirmedInfo: { ip: string; mac: string; netmask: string } | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(500);
        confirmedInfo = getInterfaceInfo(dhcpConfig.interfaceName);
        if (confirmedInfo && confirmedInfo.ip === dhcpConfig.gateway) break;
      }

      if (confirmedInfo && confirmedInfo.ip === dhcpConfig.gateway) {
        hostInfo.ip = confirmedInfo.ip;
        hostInfo.netmask = confirmedInfo.netmask;
      } else {
        dhcpConsoleLogs.push({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          message: `[자동 조치] netsh 명령은 성공했지만 어댑터 IP가 아직 ${dhcpConfig.gateway}로 반영되지 않았습니다(적용 지연 가능). 일단 서비스 시작을 계속 진행합니다.`
        });
      }

      dhcpConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level: 'SUCCESS',
        message: `[자동 조치] 어댑터가 APIPA(169.254.x.x) 상태였습니다. DHCP Pool 설정의 게이트웨이 IP(${dhcpConfig.gateway}/${dhcpConfig.subnetMask})를 이 어댑터에 고정 IP로 자동 설정했습니다.`
      });
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
        systemStatus, dhcpConfig, leases, dhcpConsoleLogs
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
  res.json({ success: true, systemStatus, dhcpConfig, leases, dhcpConsoleLogs });
});

app.post("/api/dhcp/config", (req, res) => {
  const newConfig: DhcpConfig = req.body;
  dhcpConfig = { ...dhcpConfig, ...newConfig };
  
  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    message: `DHCP parameters updated. Range: ${dhcpConfig.rangeStart} - ${dhcpConfig.rangeEnd}`
  });

  if (systemStatus.dhcpRunning) {
    const hostInfo = getInterfaceInfo(dhcpConfig.interfaceName);
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
  res.json({ success: true, dhcpConfig, leases, dhcpConsoleLogs });
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

  const subnetPrefix = hostInfo.ip.split(".").slice(0, 3).join(".") + ".";
  const found = await scanArpTable();
  const inSubnet = found.filter(d => d.ip.startsWith(subnetPrefix) && d.ip !== hostInfo.ip);

  let changed = false;
  for (const device of inSubnet) {
    // A MAC already tracked in `leases` (whether issued by the real DHCP
    // server above, a static reservation, or a previous ARP discovery) is
    // authoritative — the real DHCP server's own record for a device is
    // always more trustworthy than a possibly-stale ARP cache entry, so
    // skip it entirely rather than overwriting its IP.
    const existing = leases.find(l => l.mac === device.mac && l.status !== 'expired');
    if (existing) continue;

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
      const reservation = reservations.find(r => r.mac === d.mac);
      const lease = leases.find(l => l.mac === d.mac);
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
app.post("/api/dhcp/reservations", (req, res) => {
  const { mac, ip, hostname } = req.body;
  if (!mac || !ip || !hostname) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  const id = "res-" + Date.now();
  const newRes: DhcpReservation = { id, mac, ip, hostname };
  reservations.push(newRes);

  // Replace any existing lease already held by this MAC (dynamic or stale)
  // with the new permanent reserved lease, instead of leaving a duplicate
  // row behind — this is also what lets a currently-active real DHCP lease
  // "upgrade" cleanly into a static reservation.
  leases = leases.filter(l => l.mac !== mac || l.id === "host-pc-self");
  leases.push({
    id: "lease-res-" + Date.now(),
    ip,
    mac,
    hostname,
    interfaceName: dhcpConfig.interfaceName,
    leasedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(), // 1 year
    status: 'reserved'
  });

  dhcpConsoleLogs.push({
    timestamp: new Date().toISOString(),
    level: 'SUCCESS',
    message: `Static reservation bound: MAC ${mac} to IP ${ip}`
  });

  saveState();
  res.json({ success: true, reservations, leases, dhcpConsoleLogs });
});

app.delete("/api/dhcp/reservations/:id", (req, res) => {
  const { id } = req.params;
  const resToDelete = reservations.find(r => r.id === id);
  if (resToDelete) {
    reservations = reservations.filter(r => r.id !== id);
    // Remove static lease status
    leases = leases.filter(l => l.mac !== resToDelete.mac);
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


// TFTP / FTP File Service Controls
app.post("/api/tftpftp/toggle", (req, res) => {
  const { service, enabled } = req.body; // 'TFTP' or 'FTP'
  
  if (service === 'TFTP') {
    systemStatus.tftpRunning = enabled;
    tftpFtpConfig.tftpEnabled = enabled;
  } else if (service === 'FTP') {
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

// Resolves a user-supplied file name against the current served-folder root,
// rejecting any path that would escape outside of it (e.g. via "../").
function resolveServedPath(baseDir: string, name: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, name);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return resolvedPath;
}

// File Management inside TFTP/FTP Served directory
app.get("/api/files", (req, res) => {
  const baseDir = tftpFtpConfig.rootFolder;
  try {
    const files = fs.readdirSync(baseDir).map(fileName => {
      const filePath = path.join(baseDir, fileName);
      const stat = fs.statSync(filePath);
      return {
        name: fileName,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modifiedTime: stat.mtime.toISOString()
      };
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

app.post("/api/files/upload-simulated", (req, res) => {
  const { name, size, type } = req.body; // 'FTP' or 'TFTP'
  if (!name) return res.status(400).json({ error: "Missing name" });

  const baseDir = tftpFtpConfig.rootFolder;
  const filePath = resolveServedPath(baseDir, name);
  if (!filePath) return res.status(400).json({ error: "잘못된 파일 경로입니다." });

  try {
    fs.writeFileSync(filePath, `SIMULATED FILE BODY FOR ${name}`);

    // Create direct progress log
    const logId = "transfer-" + Date.now();
    transferLogs.push({
      id: logId,
      service: type || 'TFTP',
      clientIp: `192.168.1.${Math.floor(Math.random() * 100) + 101}`,
      operation: 'UPLOAD',
      fileName: name,
      fileSize: size || 1024 * 50,
      progress: 0,
      speed: '4.2 MB/s',
      status: 'IN_PROGRESS',
      timestamp: new Date().toISOString()
    });

    saveState();
    res.json({ success: true, transferLogs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/files/download-simulated", (req, res) => {
  const { name, type } = req.body;

  const baseDir = tftpFtpConfig.rootFolder;
  const filePath = resolveServedPath(baseDir, name);
  if (!filePath) return res.status(400).json({ error: "잘못된 파일 경로입니다." });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const stat = fs.statSync(filePath);
  const logId = "transfer-" + Date.now();
  transferLogs.push({
    id: logId,
    service: type || 'FTP',
    clientIp: `192.168.1.${Math.floor(Math.random() * 100) + 101}`,
    operation: 'DOWNLOAD',
    fileName: name,
    fileSize: stat.size,
    progress: 0,
    speed: '6.1 MB/s',
    status: 'IN_PROGRESS',
    timestamp: new Date().toISOString()
  });

  saveState();
  res.json({ success: true, transferLogs });
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
app.post("/api/hosts", (req, res) => {
  const { name, ip, port, protocol, username, password } = req.body;
  if (!name || !ip || !port || !protocol || !username) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  const id = "host-" + Date.now();
  const host: TerminalHost = { id, name, ip, port: Number(port), protocol, username, password };
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
  if (!name || !ip || !port || !protocol || !username) {
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
  host.username = username;
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
  if (!Array.isArray(devices) || devices.length === 0 || !protocol || !port || !username) {
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
      username,
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
  const currentExec = scriptExecutions.find(e => e.id === execId);
  if (currentExec) {
    currentExec.sessionOpen = false;
    if (logMessage) currentExec.logs.push(logMessage);
  }
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

        stream.on("data", (data: Buffer) => appendLog(data.toString()));
        stream.stderr?.on("data", (data: Buffer) => appendLog(data.toString()));
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

    connection.on("data", (data: Buffer) => appendLog(data.toString()));
    // Registering these before connect() also prevents Node from throwing on
    // an unhandled 'error' event once the connection is kept open past the
    // initial connect() call.
    connection.on("error", (err: any) => handleSessionEnd(err));
    connection.on("close", () => handleSessionEnd());

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
        // a time to a fully logged-in shell.
        negotiationMandatory: true
      });
    } catch (err) {
      settleOnce(err);
      return;
    }

    appendLog(`[${nowStr()}] TELNET 인증 성공. 명령 실행을 시작합니다...`);

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
  };

  if (!host.password) {
    appendLog(`[${nowStr()}] [오류] 이 호스트에 등록된 비밀번호가 없어 접속할 수 없습니다.`);
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
    `[${nowStr()}] ${host.protocol} 접속을 시도합니다: ${host.ip}:${host.port} (사용자: ${host.username})...`
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
    `[${nowStr()}] ${host.protocol} 수동 접속을 시도합니다: ${host.ip}:${host.port} (사용자: ${host.username})...`
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
          stream.on("data", (data: Buffer) => { output += data.toString(); });
          stream.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
          stream.on("error", (streamErr: any) => finish({ success: false, error: describeConnectionError(streamErr, host) }));

          stream.write("terminal length 0\n");
          setTimeout(() => stream.write("show cdp neighbors detail\n"), 500);
          setTimeout(() => stream.write("show lldp neighbors detail\n"), 2500);
          setTimeout(() => finish({ success: true, output }), 5000);
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
    connection.on("data", (data: Buffer) => { output += data.toString(); });

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
// return the raw "show cdp/lldp neighbors detail" output. Non-network
// devices (plain PCs/servers) will typically just echo back "command not
// found"-style output for these commands, which is expected and not treated
// as a request failure.
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

app.post("/api/system/reset", (req, res) => {
  // Clear persistent file state
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
  
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
  transferLogs = [];
  terminalHosts = [];
  commandScripts = [];
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
}

// Best-effort cleanup of any still-open SSH/Telnet terminal sessions on exit.
process.on("exit", () => {
  for (const session of liveSessions.values()) {
    try { session.close(); } catch { /* ignore */ }
  }
});

startServer();
