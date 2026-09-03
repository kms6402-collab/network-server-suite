# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 응답 지침

### 1. 명확하고 정확한 정보 제공
- 신뢰성 유지: 항상 검증된 정보만을 기반으로 답변하며, 정확성을 최우선으로 한다.
- 불확실한 경우 안내: 확신이 없는 정보에 대해서는 추측하지 않고, "죄송하지만 그 정보에 대해서는 확실하지 않습니다"라고 정중하게 안내한다.

### 2. 사용자 질문의 명확화
- 추가 정보 요청: 질문이 모호하거나 불명확할 경우, 필요한 추가 정보를 요청하여 정확한 답변을 제공한다.
- 단계별 접근: 복잡한 질문은 단계별로 나누어 이해하고 답변한다.

### 3. 맥락 유지 및 일관성 확보
- 이전 대화 참고: 이전 대화 내용을 고려하여 일관성 있고 관련성 높은 응답을 제공한다.
- 논리적 답변: 사용자가 제공한 정보를 기반으로 논리적이고 일관된 답변을 제공한다.

### 4. 한국어로 응답
- 언어 통일: 모든 답변은 한국어로 제공한다. 코드 주석 설명, 팁(Tip), 안내 문구 등 부가 설명도 예외 없이 한국어로 작성한다.

### 5. 복잡한 개념의 이해를 돕기
- 쉽게 설명: 복잡한 개념이나 단계는 쉽게 설명하고, 필요한 경우 예시를 제공한다.
- 단계별 진행: 문제 해결 시 단계별로 접근하며, 각 단계 후에 추가 지침이나 확인을 요청한다.

### 6. 효과적인 소통
- 명확한 표현: 명확하고 간결한 언어를 사용하여 답변한다.
- 상호작용 지원: 사용자가 보다 쉽고 편하게 상호작용할 수 있도록 노력한다.

### 7. 입력과 출력의 용이성
- 정확한 이해: 입력된 내용을 정확히 이해하고 명확하게 답변한다.
- 이해도 확인: 필요한 경우 질문을 통해 사용자의 의도를 정확히 파악한다.

### 8. 파일 첨부
- 사용자가 파일을 첨부하였다면 파일을 모두 읽고 답변해야 한다.

## 작업 처리 지침

- 여러 모듈/영역에 걸친 작업(예: DHCP, TFTP/FTP, 터미널 자동화처럼 서로 다른 기능 영역을 동시에 손봐야 하는 경우)은 가능한 한 **모듈 단위로 나눠 병렬로 처리**해서 전체 작업 속도를 높인다.
- 이 프로젝트에서 실제로 적용한 패턴: `server.ts` 안에서도 DHCP 섹션 / TFTP·FTP 섹션 / 터미널 자동화 섹션은 서로 겹치지 않는 라우트 블록으로 나뉘어 있으므로, 각 섹션과 그에 대응하는 프론트엔드 컴포넌트(`DhcpServer.tsx` / `FileServer.tsx` / `TerminalAutomation.tsx`)를 묶어 하나의 작업 단위로 삼아 동시에 진행할 수 있다.
- 병렬로 진행할 때는 각 작업 단위가 **어떤 파일/코드 영역을 건드리지 않을지**를 명확히 정해서 서로 충돌하지 않게 해야 한다(같은 파일이라도 서로 다른 함수/라우트 영역이면 동시 수정이 가능하다). `package.json`처럼 공유 자원을 바꿔야 하는 작업은 한 곳에서만 처리하도록 지정한다.
- 병렬 작업이 끝나면 반드시 통합 시점에 `npm run lint`(tsc --noEmit)와 `npm run build`를 한 번 더 실행해서 서로 다른 작업이 합쳐진 상태에서도 정상 동작하는지 확인한다.

## 프로젝트 개요

Google AI Studio로 생성된 "Network Server Suite" — DHCP/TFTP/FTP 서비스를 관리하고 SSH/Telnet 자동화 터미널 및 네트워크 로그 콘솔을 제공하는 웹 대시보드다. Express 백엔드(`server.ts`)가 상태를 메모리 + JSON 파일에 보관하며, React 프론트엔드(`src/`)가 REST API를 1.5초 간격으로 폴링해 화면을 갱신한다(웹소켓 없음).

원래는 대부분 "시뮬레이션"으로 동작했으나(가짜 데이터 재생), 실제 동작으로 개선 작업이 완료된 상태다. 자세한 개선 배경은 `IMPROVEMENT_PLAN.md` 참고.

## 자주 쓰는 명령어

```
npm install          # 의존성 설치
npm run dev           # 개발 서버 (tsx로 server.ts를 ESM으로 직접 실행, vite 미들웨어 모드로 프론트엔드 서빙)
npm run build         # vite build(프론트엔드) + esbuild로 server.ts를 dist/server.cjs로 번들 (CJS, Node용)
npm run build:exe     # build 실행 후 pkg로 Windows용 단일 실행 파일(network_server_suite.exe) 생성
npm run start         # 빌드된 dist/server.cjs를 node로 직접 실행 (프로덕션 모드 확인용)
npm run lint          # tsc --noEmit (타입 체크만, 빌드에는 관여하지 않음)
npm run clean         # dist, server.js, applet_state.json, served_folder 삭제
```

단위/통합 테스트는 존재하지 않는다.

## 아키텍처

### 백엔드 (`server.ts`, 단일 파일)

- Express 앱 하나에 모든 라우트(`/api/status`, `/api/interfaces`, `/api/dhcp/*`, `/api/tftpftp/*`, `/api/files/*`, `/api/hosts`, `/api/scripts/*`, `/api/system/*`)가 순서대로 정의되어 있다. 컨트롤러/라우터 분리 없이 하나의 파일이므로, 특정 API를 찾을 때는 `server.ts` 안에서 경로 문자열로 grep하는 것이 가장 빠르다.
- 상태는 모듈 스코프 변수(`systemStatus`, `dhcpConfig`, `leases`, `reservations`, `tftpFtpConfig`, `terminalHosts`, `commandScripts`, `scriptExecutions` 등)에 메모리로 보관되고, `saveState()`/`loadState()`가 이를 `applet_state.json`(cwd 기준)으로 직렬화/역직렬화한다. `/api/system/reset`은 이 파일을 삭제하고 메모리 상태를 초기화한다.
- `startServer()`에서 `isPackaged`(= `!!process.pkg`)가 아니고 `NODE_ENV !== "production"`일 때만 Vite 미들웨어 모드(개발 서버)를 쓰고, 그 외에는 `express.static`으로 빌드된 프론트엔드를 서빙한다. 패키징된 exe는 `NODE_ENV` 값과 무관하게 항상 운영 분기를 탄다(과거에는 `NODE_ENV`만으로 분기해서 더블클릭 시 즉시 크래시하는 버그가 있었음 — 이 조건을 다시 `NODE_ENV`만으로 되돌리지 말 것).
- `__filename`/`__dirname`은 `scriptFilename`/`scriptDirname`이라는 이름으로 `typeof __filename !== "undefined"` 가드를 두어 CJS 번들(pkg/esbuild)과 실제 ESM(tsx dev) 양쪽에서 모두 동작하도록 되어 있다. `import.meta.url`을 직접 다시 쓰지 말 것.

#### 웹 대시보드 로그인 (`server.ts`의 "WEB DASHBOARD LOGIN" 주석 블록)

- `startServer()`가 `app.listen(PORT, "0.0.0.0", ...)`로 바인딩하므로 이 앱의 대시보드는 이 PC뿐 아니라 같은 네트워크의 다른 PC에서도 접속·조작할 수 있다(DHCP 설정, TFTP/FTP 공유 폴더, 저장된 SSH/Telnet 장비 계정까지 전부). 그래서 인증 없이는 아무 `/api/*`도 쓸 수 없다 — `/api/auth/status`·`/api/auth/setup`·`/api/auth/login`·`/api/auth/logout` 4개만 인증 없이 공개되어 있고, 그 4개를 등록한 *바로 다음 줄*에 `app.use("/api", requireAuth)`를 걸어서 그 아래에 정의된(파일 순서상 이후의) 모든 라우트가 자동으로 보호된다 — 새 `/api/*` 라우트를 추가할 때 이 미들웨어보다 위에 쓰면 보호 없이 노출되니 주의.
- 계정은 딱 1개만 존재할 수 있다(`webAuth: {username, passwordHash, passwordSalt} | null`, 다중 사용자 개념 없음). `webAuth`가 `null`이면(최초 실행이거나 공장 초기화 직후) 프런트엔드는 로그인 폼이 아니라 "관리자 계정 생성" 폼(`Login.tsx`, `configured={false}`)을 보여준다 — 그 외에는 별도 우회 경로 없이 반드시 이 계정 생성을 거쳐야 대시보드에 들어갈 수 있다.
- 비밀번호는 평문으로 저장/기록되지 않는다 — `crypto.scryptSync(password, salt, 64)` + 계정당 랜덤 salt, 비교는 `crypto.timingSafeEqual`. 이 앱은 TLS가 전혀 없는 순수 HTTP라서 세션 쿠키(`nss_session`)에 `secure` 플래그를 걸지 않는다(걸면 http://로는 브라우저가 쿠키를 아예 안 보냄) — 능동적인 네트워크 도청자를 막으려는 게 아니라 LAN의 아무나가 그냥 접속하는 것만 막는 수준의 보안 모델임을 인지할 것.
- 세션은 메모리(`webSessions: Map<token, createdAt>`)에만 있고 재시작하면 전부 로그아웃된다(정상 동작). `express`가 `res.cookie()`/`res.clearCookie()`는 기본 제공하지만 들어오는 쿠키 파싱은 `cookie-parser` 없이는 안 해주므로, `parseCookies()`로 `Cookie` 헤더를 직접 2줄짜리로 파싱한다 — 이 때문에 새 의존성이 추가되지 않았다.
- `POST /api/system/reset`(공장 초기화)은 `webAuth = null; webSessions.clear();`도 함께 수행한다 — 다른 모든 설정처럼 계정도 초기화 대상이고, 이 요청을 보낸 바로 그 세션도 초기화 직후부터는 다시 계정 생성부터 시작해야 한다(라우터 초기화와 동일한 사용자 경험).
- 프런트엔드 흐름: `App.tsx`가 마운트되자마자 `/api/auth/status`로 `{configured, authenticated}`를 확인해 `authStatus`(`checking`/`setup`/`login`/`ready`)를 정하고, `ready`가 아니면 나머지 폴링(`fetchAllState` 등)을 아예 시작하지 않는다(로그인도 안 된 상태에서 401 나올 게 뻔한 요청들을 쏟아내지 않기 위함). 폴링 중 세션이 만료되면(`/api/status`가 401) 조용히 `checkAuthStatus()`를 다시 불러 로그인 화면으로 돌아간다. `SystemSettings.tsx`에 비밀번호 변경 폼과 로그아웃 버튼이 있고, 헤더에도 로그아웃 아이콘 버튼이 있다.

#### DHCP (실제 어댑터 기반 + 진짜 DHCP 서버, 위험을 인지하고 사용자가 명시적으로 선택)

- `dhcpConfig.interfaceName`의 기본값은 `getDefaultInterfaceName()`이 `os.networkInterfaces()`로 찾은 첫 번째 실제(non-internal) IPv4 어댑터로 자동 설정된다. 서버 기동 시 `loadState()` 이후, 저장된 어댑터가 현재 호스트에 없으면(다른 PC의 설정을 그대로 들고 온 경우 등) 자동으로 실제 어댑터 기준으로 self-heal한다(`ensureDhcpConfigMatchesHost()`, DHCP 토글 on 시점에도 재검증). 이때 어댑터 자체가 바뀌었다면(단순히 게이트웨이만 무효했던 경우가 아니라) `dhcpConfig.serverIp`도 함께 비운다 — 예전 어댑터에서만 의미 있던 값이라 새 어댑터로 그대로 들고 가면 안 되기 때문.
- `getInterfaceInfo(name, preferredIp?)`은 어댑터를 찾지 못하면 가짜 IP/MAC을 반환하지 않고 `null`을 반환한다 — 호출부는 반드시 null 체크를 해야 한다. `preferredIp`가 주어지고 그 어댑터가 실제로 그 주소를 갖고 있으면(기본 주소든, `ensureServerIpOnAdapter`가 보조로 추가한 주소든) 그걸 우선 반환하고, 없으면 어댑터의 첫 번째 non-internal IPv4로 조용히 폴백한다.
- **DHCP 서버 자신의 IP와 클라이언트에게 알려주는 게이트웨이는 서로 다른, 독립적인 값이다(중요, 되돌리지 말 것)**: 과거에는 `dhcpConfig.gateway`가 곧 "이 앱 자신의 IP"를 의미했다 — 게이트웨이 기본값이 항상 어댑터의 실제 IP로 채워졌고, 관리자가 입력한 게이트웨이 값을 어댑터에 보조(alias) IP로 강제로 붙여서 "게이트웨이 = 이 PC 자신"이 항상 참이 되도록 만들었다. 그 결과 DHCP로 IP를 받은 단말은 게이트웨이가 실제 라우터가 아니라 이 DHCP 서버 PC 자신이 되어버렸고, 이 앱은 IP 포워딩/NAT을 하지 않으므로 그 단말은 게이트웨이를 통한 정상적인 통신(인터넷/다른 대역 접근)이 불가능했다. 지금은 완전히 분리되어 있다:
  - **DHCP 서버 IP**(옵션 54/siaddr — 클라이언트에게 "이 서버가 나다"라고 알려주는 값)는 `dhcpConfig.serverIp`가 비어 있으면(기본값) 선택된 어댑터의 실제 현재 IP를 그대로 쓰고, 값이 설정돼 있으면 그 IP를 우선 사용한다(어댑터에 그 IP가 없으면 아래 `ensureServerIpOnAdapter`가 보조 주소로 자동 추가한다). 실제 반영된 값은 저장되는 설정과 별개로 매 요청마다 `getCurrentDhcpServerIp()`로 즉석에서 계산되며, `/api/status`·`/api/dhcp/toggle`·`/api/dhcp/config` 응답의 `dhcpServerIp` 필드로 노출되고 `DhcpServer.tsx`에 "현재 서버 IP" 배지로 표시된다. `DhcpServer.tsx`의 "DHCP 서버 IP(선택)" 입력창이 `dhcpConfig.serverIp`를 편집하는 곳이고, 비워두면 자동(어댑터 IP 그대로) 동작이다.
  - **`dhcpConfig.gateway`**(옵션 3/router — 클라이언트가 실제로 트래픽을 보낼 라우터 주소)는 완전히 독립적인, 관리자가 직접 입력하는 값이다. 기본값은 어댑터 IP가 아니라 그 서브넷의 관용적인 `.1`이다(다른 DHCP 서버들과 동일한 방식의 추측값일 뿐, 바로 저장/사용 가능하지만 실제 라우터 주소로 바꿔야 한다). `DhcpServer.tsx`의 어댑터 변경 핸들러(`handleInterfaceChange`)도 동일하게 `.1`을 기본값으로 채우고, 동시에 `serverIp`도 비운다(위 self-heal과 같은 이유).
  - **`ensureServerIpOnAdapter(interfaceName, serverIp, subnetMask)`**: `dhcpConfig.serverIp`가 설정돼 있고 그 IP가 선택된 어댑터에 아직 없으면, PowerShell `New-NetIPAddress`(실패 시 `netsh interface ip add address` 폴백)로 **그 어댑터에만** 보조 IP로 추가한다 — 다른 어댑터는 절대 건드리지 않는다. 어댑터의 기존 기본 IP(DHCP/APIPA/수동 등 무엇이든)는 손대지 않는다. `/api/dhcp/toggle`(enabled:true)과 `/api/dhcp/config`(DHCP가 이미 가동 중일 때) 양쪽에서 호출된다. `managedServerIpAlias`가 마지막으로 추가한 별칭을 기억해뒀다가, 관리자가 serverIp를 다른 값으로 바꾸면 이전 별칭을 `removeServerIpAlias()`로 정리하고, 아예 빈 값(자동)으로 되돌리면 별칭 자체를 제거한다 — 어댑터에 별칭이 계속 쌓이지 않도록. (이 메커니즘은 예전에 게이트웨이를 위해 있다가 v2.6.0에서 완전히 삭제됐던 것과 동일한 코드를 서버 IP 목적으로 되살린 것 — 게이트웨이 자체는 이제 이 메커니즘을 쓰지 않는다.)
  - `/api/dhcp/config`는 게이트웨이가 바뀐 것만으로는 어댑터에 아무 것도 하지 않는다 — DHCP가 이미 가동 중일 때 `interfaceName`이 바뀌었거나 `serverIp`가 바뀐 경우에 한해 어댑터를 갱신하고, `host-pc-self` 리스 항목도 그 결과에 맞춰 갱신한다.
- **DHCP는 프로그램 실행 시 자동으로 켜지지 않는다(중요, 되돌리지 말 것)**: `loadState()`가 `systemStatus.autoStart`(기본 true)일 때 TFTP/FTP는 실제로 재기동시키지만(`startServer()`가 `startTftpServer()`/`startFtpServer()` 호출), DHCP는 소켓을 절대 자동으로 열지 않는다 — 같은 네트워크에 이미 다른 DHCP 서버(공유기 등)가 있으면 충돌 위험이 있어서, 매번 사용자가 UI 토글로 의식적으로 재확인하도록 설계된 것이다. 과거에는 `loadState()`가 `systemStatus.dhcpRunning`을 무조건 `true`로 세팅해버리는 버그가 있었다(로그도 "Auto-started DHCP Server"라고 거짓으로 남겼다) — 실제 소켓은 안 열리는데 UI에는 프로그램을 켤 때마다 "가동중"으로 표시돼서, 마치 DHCP가 항상 자동으로 실행되는 것처럼 보였다. 지금은 `loadState()`의 두 복원 경로(applet_state.json JSON 경로, setting.ini 폴백 경로) 모두에서 `systemStatus.dhcpRunning`을 명시적으로 `false`로 강제한다 — 이 줄을 지우거나 다시 `true`로 되돌리지 말 것.
- `/api/interfaces`는 non-internal IPv4가 있는 어댑터만 반환한다(루프백 등 내부 전용 어댑터는 목록에서 제외). `DhcpServer.tsx`에 이 목록을 강제로 다시 조회하는 "새로고침" 버튼이 있다.
- **진짜 DHCP 서버가 구현되어 있다** (`server.ts`의 "ADAPTER ISOLATION" 주석 블록부터 시작하는 섹션, `startDhcpServer`/`stopDhcpServer`, DISCOVER/REQUEST/RELEASE 핸들러). `/api/dhcp/toggle`이 `enabled:true`가 되면 실제 UDP 소켓을 열어 DORA(Discover-Offer-Request-Ack) 프로토콜을 처리하고, `enabled:false`면 소켓을 닫는다. Node `dgram`으로 직접 구현했다(마땅한 유지보수 중인 npm 패키지가 없었음, RFC 2131/2132 패킷을 직접 파싱/생성). 새 의존성 없음.
  - **바인딩 제약(중요, 되돌리지 말 것)**: 리스닝 소켓은 `0.0.0.0:67`에 바인딩된다 — Windows에서 UDP 소켓을 특정 유니캐스트 IP에만 바인딩하면 브로드캐스트(DHCPDISCOVER는 255.255.255.255로 옴)를 아예 못 받는다(OS 레벨 제약, dgram으로 우회 불가). 대신 **선택된 어댑터로만 격리**되도록 소프트웨어적으로 강제한다: 모든 OFFER/ACK/NAK는 선택된 어댑터 서브넷의 directed broadcast 주소(예: `10.0.5.255`, 전역 `255.255.255.255` 아님)로만 보내서 OS 라우팅이 그 응답을 오직 해당 NIC로만 내보내게 하고, source IP가 있는 인바운드 패킷(REQUEST/RELEASE 등)은 선택된 서브넷 범위 밖이면 버린다. 이 격리 로직을 약화시키거나 전역 브로드캐스트로 바꾸지 마라 — 다른 인터페이스/네트워크에 영향을 주지 않아야 한다는 게 이 기능의 핵심 요구사항이었다.
  - 관리자 권한이 없어 포트 67 바인드가 실패하면(`EACCES` 등) 크래시하지 않고 `dhcpConsoleLogs`에 한글 오류를 남기고 `systemStatus.dhcpRunning`을 false로 되돌린다. `/api/dhcp/toggle` 응답에도 `{success:false, error}`로 반영된다.
  - **동일 네트워크에 이미 실제 DHCP 서버(공유기 등)가 있으면 충돌 위험이 있다** — 사용자가 이 위험을 명시적으로 인지하고 선택한 것이다. `DhcpServer.tsx`는 "임대 서비스 가동" 클릭 시 세션당 1회 `window.confirm` 경고를 띄우고, 서버 시작 시 `dhcpConsoleLogs`에도 경고를 1회 남긴다.
  - `reservations`(고정 IP 예약)에 있는 MAC은 우선적으로 그 고정 IP를 할당받는다. 리스 만료는 2초 틱커에서 함께 정리된다.
  - `DELETE /api/dhcp/leases/:id` — 개별 리스 삭제(반환). `leases` 배열뿐 아니라 DHCP 서버 내부 임대 추적 구조에서도 함께 제거해서 그 IP가 즉시 재할당 가능한 상태가 된다. `host-pc-self`는 삭제 대상에서 제외.
  - `scanArpTable()`/`discoverNetworkDevices()`(ARP 캐시 기반 보조 탐지)는 그대로 남아있고, 진짜 서버가 이미 발급한 리스(같은 MAC)는 덮어쓰지 않도록 되어 있다 — 정적 IP를 쓰는 기기 등 진짜 서버가 못 잡는 기기를 보조적으로 보여주는 용도.
  - **MAC 주소는 항상 `normalizeMac()`(대문자 + `:` 구분자)으로 비교해야 한다(중요, 되돌리지 말 것)**: 실제 DHCP 패킷의 `chaddr`은 항상 이 형식으로 정규화되어 저장되지만, 예약 폼이나 CSV 가져오기로 사람이 직접 입력한 MAC은 대소문자/구분자가 제각각일 수 있다. 예전에는 `l.mac === mac` 같은 대소문자 구분 비교를 써서, 사람이 소문자로 입력한 예약이 이미 있던 대문자 리스 레코드를 못 찾아 지우지 못하고 중복으로 남거나(같은 IP/MAC이 목록·CSV 내보내기에 두 번 찍히는 버그의 원인), `handleDhcpRelease`가 반환된 MAC의 기존 레코드를 못 찾아 리스가 초기화되지 않는 버그가 있었다. `upsertLease`/`upsertReservation`/DISCOVER·REQUEST·RELEASE 핸들러/ARP 탐지/`arp-table` 라우트 전부 `normalizeMac()` 비교로 통일되어 있다.
  - `upsertReservation(mac, ip, hostname)`이 예약 생성·수정·CSV 가져오기의 공통 경로다 — 같은 MAC으로 다시 호출하면(대소문자가 달라도) 기존 예약/리스를 지우고 새로 만들며, 요청한 IP가 *다른* MAC에 이미 예약돼 있으면 `null`을 반환해 호출부가 충돌로 처리한다.
  - `PUT /api/dhcp/reservations/:id` — 예약 수정(과거엔 삭제 후 재등록만 가능했다). MAC 자체를 바꾸는 경우까지 처리하기 위해, 먼저 기존 MAC의 리스를 정리한 뒤 `upsertReservation`으로 새 값을 반영한다.
  - `POST /api/dhcp/reservations/bulk-import`(`reservations: {mac,ip,hostname}[]`) — CSV 일괄 등록. 다른 bulk-import들과 같은 패턴으로 프런트엔드(`DhcpServer.tsx`)가 CSV를 직접 파싱해서 평범한 JSON 배열로 보낸다(멀티파트 업로드나 CSV 파싱 의존성 없음). 형식 오류/IP 충돌 행은 건너뛰고 `{imported, skipped}`로 개별 사유를 반환, 한 줄이 잘못됐다고 전체가 실패하지 않는다.
  - `handleDhcpRelease`는 `status !== 'reserved'`인 리스만 완전히 `splice`로 제거한다(만료 표시가 아니라 배열에서 실제로 삭제) — 반환된 MAC은 즉시 재할당 가능해지고 "할당 단말 현황"에 남지 않는다. 고정 예약은 반환으로 없어지지 않는 게 의도된 동작.
  - "할당 단말 현황" 테이블(`DhcpServer.tsx`)은 모든 컬럼이 클릭으로 정렬 가능하다(`leaseSortKey`/`leaseSortDir`, IP는 문자열이 아니라 옥텟 단위 숫자로 비교) — 이 정렬은 그리드 뷰와 CSV 내보내기에도 그대로 적용된다(`filteredLeases`가 검색 필터링 + 정렬을 함께 담당).

#### TFTP/FTP (실제 프로토콜 서버, 진짜 DHCP 서버와 동일한 방향성)

- `tftpFtpConfig.rootFolder`는 실제로 편집 가능하다. `/api/tftpftp/config`가 경로를 `path.resolve()`로 정규화하고, 존재하지 않으면 생성(`fs.mkdirSync(recursive)`), 디렉터리인지(`fs.statSync().isDirectory()`), 쓰기 권한이 있는지(`fs.accessSync(W_OK)`)를 검증한 뒤에만 저장한다. `FileServer.tsx`에는 이 값을 직접 타이핑하는 대신 "찾아보기" 버튼(`POST /api/tftpftp/browse-folder`)이 있다 — 서버가 로컬 데스크톱 앱이라 "서버 머신"이 곧 브라우저를 여는 그 머신이라는 전제로 동작하며, 버튼은 입력창을 채우기만 하고 실제 적용은 여전히 "설정 저장" 버튼(`/api/tftpftp/config`)이 담당한다. 이 버튼은 WinForms `FolderBrowserDialog`(레거시 `SHBrowseForFolder` 트리 전용 다이얼로그, 주소/경로 입력창 자체가 없어 트리를 계속 눌러 내려가야만 했다) 대신 `Shell.Application` COM의 `BrowseForFolder`를 `BIF_USENEWUI`(`BIF_NEWDIALOGSTYLE|BIF_EDITBOX`) + `BIF_RETURNONLYFSDIRS` 플래그(`0x51`)로 호출한다 — 하단에 경로를 직접 타이핑하거나 붙여넣을 수 있는 입력창이 있고 크기 조절도 가능한 탐색기 스타일 창이 뜬다.
- **PowerShell 스크립트 출력의 한글 깨짐(중요, 되돌리지 말 것)**: `runPowerShellScript()`(`server.ts`)가 실행하는 Windows PowerShell 5.1은 콘솔 출력 코드페이지를 UTF-8이 아니라 시스템 레거시 ANSI/OEM 코드페이지(한글 Windows면 CP949)로 기본 설정한다 — 스크립트 자체는 `-EncodedCommand`로 UTF-16LE/Base64 인코딩해서 넘기지만, 이건 스크립트 "입력" 인코딩일 뿐 `Write-Output`이 다시 내보내는 "출력" 인코딩과는 무관하다. 그 결과 `/api/tftpftp/browse-folder`에서 한글이 포함된 폴더 경로를 선택하면 Node가 그 stdout을 UTF-8로 디코딩하는 과정에서 완전히 깨진 문자열이 돼버렸다. `runPowerShellScript()`는 이제 모든 스크립트 앞에 `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`를 프리앰블로 붙여서 이 문제를 근본적으로 막는다 — 이 프리앰블을 제거하면 한글 경로/텍스트를 반환하는 모든 PowerShell 호출이 다시 깨진다. 같은 프리앰블에서 `$ProgressPreference = 'SilentlyContinue'`도 함께 설정해 일부 cmdlet(`New-Object`, `New-NetIPAddress` 등)이 남기는 진행률 레코드가 stderr에 CLIXML 노이즈로 섞이는 것도 막는다.
- TFTP 요청 파싱(`parseTftpRequest`)에서 파일명을 `msg.toString("ascii", ...)`로 읽던 것도 `"utf8"`로 바꿨다 — ascii 디코딩은 각 바이트의 최상위 비트를 그냥 날려버려서, 한글처럼 UTF-8 멀티바이트로 인코딩된 파일명(대부분의 최신 TFTP 클라이언트가 이렇게 보낸다)이 전송될 때마다 파일명이 깨졌다. 순수 ASCII 파일명에는 두 디코딩이 동일하게 동작하므로 회귀 없이 한글 파일명만 추가로 올바르게 처리된다.
- 파일 관련 라우트(`/api/files` 등)는 하드코딩된 `SERVED_FOLDER` 상수 대신 **요청마다** `tftpFtpConfig.rootFolder`를 다시 읽어서 기준 디렉터리로 사용한다(모듈 로드 시점에 캐싱하지 않음). `SERVED_FOLDER` 상수는 최초 기본값과 `/api/system/reset` 초기화용으로만 남아 있다.
- `resolveServedPath(baseDir, name)` 헬퍼가 사용자가 지정한 파일명이 `baseDir` 바깥으로 벗어나지 않는지(`../` 경로 탈출 방지) 검증하며, 벗어나면 400을 반환한다.
- **`/api/tftpftp/toggle`가 켜졌을 때 실제로 UDP 69(TFTP)/TCP 21(FTP) 포트를 열어 진짜 파일 전송을 처리한다** — 예전에는 상태 플래그만 뒤집고 `/api/files/upload-simulated`·`/api/files/download-simulated`가 가짜 문자열을 파일에 써넣는 시뮬레이션이었으나(두 라우트 모두 제거됨), 이제 원격 장비(또는 실제 `tftp`/`ftp` 클라이언트, `curl ftp://...`)가 붙어 진짜로 파일을 주고받는다.
  - **TFTP**는 DHCP처럼 마땅한 유지보수 중인 npm 서버 패키지가 없어서 `dgram` 위에 RFC 1350을 직접 구현했다(`startTftpServer`/`stopTftpServer`, RRQ/WRQ/DATA/ACK/ERROR). 소켓 하나를 `0.0.0.0:tftpPort`에 바인딩하고 `(클라이언트 IP, 클라이언트 포트)` 튜플로 세션(`tftpSessions: Map`)을 구분한다 — 표준 구현처럼 전송마다 새 포트로 갈아타지는 않지만 RFC상 문제없고, 다수 클라이언트가 동시에 붙어도 튜플 단위로 안전하게 분리된다. 옵션 협상(OACK, blksize 등)은 구현하지 않고 항상 512바이트 블록의 기본 프로토콜만 지원한다 — 옵션을 요청하는 클라이언트가 있어도 그냥 무시하고 base 프로토콜로 응답하면 대부분의 클라이언트가 자동으로 폴백한다.
  - **FTP**는 순수 JS 유지보수 패키지 `ftp-srv`를 사용한다(DHCP/TFTP와 달리 이 경우는 검증된 라이브러리가 있어서 직접 구현하지 않았다). **화이트리스트 인증** — `ftpCredentials: FtpCredential[]`(모듈 스코프 상태, `applet_state.json`/`setting.ini` 양쪽에 영속화)에 등록된 `{username, password}` 정확히 일치하는 조합만 로그인 허용, 목록이 비어 있으면 아무도 못 들어온다(과거에는 아이디만 있으면 무조건 통과시켰으나 인증이 아니었다는 사용자 피드백으로 교체됨). 관리 라우트는 `POST /api/tftpftp/credentials`(추가, 중복 아이디 거부)/`DELETE /api/tftpftp/credentials/:id`, UI는 `FileServer.tsx`의 "FTP 계정" 패널(비밀번호는 등록 후 다시 표시하지 않음 — `TerminalHost` 비밀번호와 동일한 write-only 패턴). PASV 데이터 채널 IP는 `resolveFtpPasvAddress()`가 접속한 클라이언트와 같은 서브넷의 로컬 어댑터 IP를 찾아 돌려주고(루프백 접속이면 127.0.0.1), PASV 포트 범위는 50000-50099로 제한했다. `ftp-srv`는 `new FtpSrv(...)`를 호출할 때마다 `process`에 SIGTERM/SIGINT/SIGQUIT 리스너를 추가하고 `close()`해도 제거하지 않는 라이브러리 자체 버릇이 있어서, `process.setMaxListeners()`를 올려 반복 토글 시 `MaxListenersExceededWarning`이 뜨지 않게 해뒀다. 기본 bunyan 로거는 콘솔에 매우 시끄러워서 무음 로거(`createSilentFtpLogger`)로 교체했다.
  - **`resolveServedPath`가 공유 폴더를 드라이브 루트(`D:\` 등)로 지정했을 때 모든 파일을 "경로 탈출"로 오판하던 버그가 수정됨(중요, 되돌리지 말 것)**: `path.resolve()`가 돌려주는 드라이브 루트는 이미 구분자로 끝나는데(`"D:\\"`), 예전 코드는 여기에 무조건 `path.sep`를 추가로 붙여 `"D:\\\\"`와 비교했다 — 드라이브 루트 바로 아래 파일은 전부 이 이중 구분자로 시작하지 않으니 매번 escape 시도로 오판되어 TFTP RRQ/WRQ와 `/api/files/create`·`delete`가 전부 "Access violation"으로 막혔다. 지금은 `resolvedBase`가 이미 구분자로 끝나는지 먼저 확인하고 필요할 때만 붙인다. `/api/files`(목록 조회)도 같은 맥락의 별개 버그가 있었다 — 드라이브 루트를 공유하면 `System Volume Information`처럼 관리자도 `stat()` 못 하는 OS 보호 폴더가 섞여 있어 한 항목의 예외가 전체 목록 조회를 500으로 죽였다; 지금은 항목별로 개별 try/catch로 감싸서 그런 항목만 건너뛴다.
  - 전송 완료/실패는 `transferLogs`에 실시간으로 기록된다(`logTransferStart`/`finalizeTransferLog`). **`saveState()`는 전송 시작·종료 시점에만 호출된다** — TFTP는 블록(512바이트)마다 ACK/DATA가 오가므로 매 블록마다 저장하면 `saveState()`의 동기 전체 파일 쓰기 때문에 큰 파일 전송이 극도로 느려진다. FTP는 `ftp-srv`의 `STOR`/`RETR` 커넥션 이벤트가 전송 "완료 후"에만 발생해 시작 시각을 알 수 없으므로 전송 속도는 `-`로 표기하고, TFTP는 시작 시각을 알고 있어 실제 MB/s를 계산한다.
  - 프로세스가 부팅될 때(`startServer()`) `systemStatus.tftpRunning`/`ftpRunning`이 복원된 상태로 true면 실제로 `startTftpServer()`/`startFtpServer()`를 호출해 진짜로 재기동한다. **DHCP는 의도적으로 제외** — DHCP는 다른 네트워크와 충돌할 실제 위험이 있어 재부팅마다 자동으로 다시 붙는 대신 사용자가 매번 토글로 재확인하도록 남겨뒀다(프론트의 `window.confirm` 경고와 짝을 이루는 설계).
  - `/api/system/reset`(공장 초기화)도 상태 플래그만 초기화하는 게 아니라 `stopDhcpServer()`/`stopTftpServer()`/`stopFtpServer()`를 실제로 호출해 진짜 서버까지 내린다 — 안 그러면 화면은 "꺼짐"인데 뒤에서는 계속 떠 있는 상태가 된다.

#### 터미널 자동화 (실제 SSH/Telnet, 연결 유지 + 수동 CLI + 동시 세션 브로드캐스트)

- `/api/scripts/execute`는 명령어 패턴에 맞춰 캔(canned) 텍스트를 흘려보내지 않는다. `runScriptExecution()`이 `host.protocol`에 따라 `runSshExecution()`(`ssh2`의 `Client` + `conn.shell()`) 또는 `runTelnetExecution()`(`telnet-client`)으로 실제 접속하고, 셸에서 오는 데이터를 실시간으로 `execution.logs`에 append한다(기존 1.5초 폴링 구조를 그대로 활용, 웹소켓 도입 없음).
- 연결 실패는 `describeConnectionError()`가 실제 에러 코드(`ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENOTFOUND`, 인증 실패 등)를 한글 메시지로 변환해 로그에 남기고 `execution.status = 'failed'`로 설정한다. 호스트에 비밀번호가 없으면 접속 시도 없이 즉시 실패 처리한다.
- **연결을 스크립트 종료 후에도 유지**한다: `runSshExecution`/`runTelnetExecution`이 스크립트의 모든 명령을 다 보낸 뒤 연결을 바로 끊지 않고, 모듈 스코프 레지스트리 `liveSessions: Map<execId, { protocol, write, close }>`에 등록해 살려둔다. `ScriptExecution.sessionOpen`(`src/types.ts`에 추가된 필드)이 이 상태를 프론트에 노출한다. 연결은 (a) 사용자가 명시적으로 종료 요청(`POST /api/terminal/disconnect`), (b) 연결 자체 에러/종료, (c) 실행 자체가 실패한 경우에만 닫힌다. `closeLiveSession()` 헬퍼가 정리를 담당.
- `POST /api/terminal/connect`(`hostId`) — 스크립트 없이 순수 접속만 수행(빈 명령 목록의 "manual" 센티널 스크립트로 `runScriptExecution` 재사용), 성공하면 즉시 `liveSessions`에 등록되어 수동 CLI를 바로 쓸 수 있다.
- `POST /api/terminal/send`(`execIds: string[]`, `command`) — 각 `execId`의 살아있는 세션에 명령을 써넣는다. **`execIds`가 1개면 단일 세션 전송, 여러 개면 SecureCRT의 "Send to all sessions"와 같은 동시 브로드캐스트**가 된다(프론트의 "모든 활성 세션에 동시 전송" 체크박스가 이 배열을 구성). 개별 세션이 닫혀 있으면 그 세션만 `errors`에 담고 나머지는 정상 전송(부분 실패 허용).
- `POST /api/terminal/disconnect`(`execId`) — **연결만** 끊는다(살아있는 세션을 종료시키지만 세션 탭/기록 자체는 목록에 남는다). 아래의 "세션 완전히 닫기"와는 별개 기능이며 둘 다 유지해야 한다.
- `DELETE /api/scripts/executions/:id` — 세션을 **완전히 닫기**: 살아있으면 먼저 `closeLiveSession()`으로 연결을 끊고, `scriptExecutions` 배열에서 해당 기록 자체를 제거한다(탭이 목록에서 사라짐). `POST /api/scripts/executions/close-all`은 모든 세션에 대해 동일한 처리를 하고 배열을 통째로 비운다.
- `TerminalAutomation.tsx` 로그 뷰어 자동 스크롤: **콘텐츠가 갱신된 "이후" 시점의 `scrollHeight`로 거리(distance-from-bottom)를 계산하면 안 된다** — 이미 늘어난 `scrollHeight` 기준으로 재계산하면, 로그가 여러 줄 한꺼번에 도착했을 때(SSH/Telnet 스트림 응답이 뭉쳐서 옴) 사용자가 실제로는 하단에 있었어도 거리 임계값을 초과해버려 자동 스크롤이 안 걸리는 역설이 생긴다(과거 이 버그로 "새 로그가 계속 쌓이는데 자동으로 안 내려간다"는 회귀가 있었다). 올바른 방식: 스크롤 컨테이너에 `onScroll` 핸들러를 걸어 사용자가 스크롤할 때마다 `isNearBottomRef`를 갱신해두고, 로그 갱신 `useEffect`에서는 **갱신 전에 기록해둔 이 ref 값**을 기준으로 자동 스크롤 여부를 판단한다(post-hoc 재계산 금지). 세션 탭 전환 시에는 여전히 무조건 맨 아래로 이동.
- `.log` 내보내기는 백엔드 없이 `Blob`+`URL.createObjectURL`로 클라이언트에서 바로 다운로드한다. 장비/스크립트 목록에는 수정(편집) 버튼이 있고, 기존 등록 폼을 편집 모드로 재사용한다.
- **장비 대량 관리**: `POST /api/hosts/bulk-import`(`devices: {name,ip}[]`, 공통 `protocol`/`port`/`username`/`password`) — DHCP `leases`(`host-pc-self` 제외)를 소스로 여러 장비를 한 번에 등록, IP 중복은 자동 스킵(`{imported, skipped}` 응답). `POST /api/hosts/bulk-update`(`ids`, 선택적 `protocol`/`port`/`username`/`password`) — 제공된 필드만 일괄 반영, `name`/`ip`는 절대 건드리지 않음(계정 정보 전용). `POST /api/hosts/bulk-delete`(`ids`) — 일괄 삭제. `TerminalAutomation.tsx`의 장비 목록에 체크박스 다중 선택 + DHCP 가져오기 패널이 있다.
  - DHCP 가져오기 패널의 임대 체크리스트는 호스트명/IP/MAC 필터 입력창(`leaseFilterText`)을 갖고 있고, "전체 선택/해제"와 목록 자체는 `importableLeases`가 아니라 그걸 필터링한 `filteredImportableLeases`에 대해서만 동작한다 — 필터 밖에 있는 기존 선택은 건드리지 않는다(`toggleSelectAllFilteredLeases`). 실제 등록(`handleDhcpImportSubmit`)은 필터와 무관하게 `selectedLeaseIds`에 담긴 전체 선택 목록 기준으로 동작.
  - 리스트 각 행은 `flex` 부모 안에서 호스트명 span에 `truncate`만 걸려 있으면 안 된다(비직관적) — flex item의 기본 `min-width`는 `auto`라서 `min-w-0`이 없으면 `truncate`가 사실상 무시되고 IP/MAC과 공간을 나눠 가지며 이상하게 잘린다. 지금은 호스트명을 `min-w-0 flex-1`인 래퍼로 감싸고 그 안에서 호스트명(위 줄, `truncate`+`title`)과 IP/MAC(아래 줄, 작은 폰트)을 분리해 2줄로 배치했다 — 이 구조를 다시 한 줄짜리 flex row로 되돌리지 말 것.
- **Telnet 로그인 레이스 컨디션(수정됨)**: `runTelnetExecution`에서 `telnet-client`의 `connect()` 옵션에 `negotiationMandatory: false`가 있으면, 실제 로그인/셸 프롬프트 도달을 기다리지 않고 TCP 연결 시점에 바로 resolve되어버려서, 스크립트의 첫 명령 1~2개가 로그인 아이디/비밀번호로 잘못 소비되는 버그가 있었다. `negotiationMandatory: true`(라이브러리 기본값)로 고정되어 있다 — 다시 `false`로 바꾸지 말 것.
- **계정 정보 없이 장비 등록 (TELNET 전용)**: `TerminalHost`는 `username`/`password`가 둘 다 비어 있는 상태로 등록할 수 있다 — `/api/hosts`, `/api/hosts/:id`, `/api/hosts/bulk-import` 모두 `username`을 더 이상 필수로 받지 않는다. 스크립트 자신이 로그인 아이디/비밀번호를 명령으로 직접 입력해 처리하고, 앱은 "장비에 접속"까지만 해주면 되는 경우를 위한 옵션이다(`TerminalAutomation.tsx`의 "계정 정보 없이 등록" 체크박스, 장비 추가/수정 폼과 DHCP 가져오기 패널 양쪽에 있음). SSH는 프로토콜 자체가 인증을 핸드셰이크의 일부로 요구해서 자격 증명 없이는 셸에 도달할 방법이 없으므로 이 옵션은 TELNET에서만 허용된다 — UI에서 SSH 선택 시 체크박스가 비활성화되고, 서버(`runScriptExecution`)도 `host.protocol === "SSH"`면서 비밀번호가 없으면 접속 자체를 시도하지 않고 즉시 실패 처리한다.
  - `runTelnetExecution`에서 `host.password`가 없으면 `telnet-client`의 자동 로그인 상태 기계를 완전히 우회하고 원본 연결만 연다. **주의(비직관적)**: `username`/`password`/`shellPrompt`/`loginPrompt`/`passwordPrompt` 옵션을 그냥 생략하면 안 된다 — `telnet-client`의 `defaultOptions`가 이미 `username:'root'`, `password:'guest'`, `shellPrompt:/(?:\/ )?#\s/` 등 매우 그럴듯한 기본값을 갖고 있어서(`Object.assign`으로 병합됨), 생략하면 실제로 device의 "Password:" 프롬프트에 문자열 `guest`를 자동으로 써버리는 것까지 실제 테스트로 확인했다. 올바른 방법은 `shellPrompt`에 명시적으로 falsy 값(`false`)을 넘기는 것 — `telnet-client`의 `socket.on('connect', ...)` 핸들러가 `!this.opts.shellPrompt`일 때 데이터가 오기도 전에 내부 상태를 `'standby'`로 바꿔버려서, 이후로는 로그인 프롬프트 감지 로직 자체가 다시 실행되지 않는다(그 상태 전이는 `'getprompt'` 상태에서만 일어남). `loginPrompt`/`passwordPrompt`/`failedLoginMatch`는 방어적으로 `/(?!)/`(항상 매칭 실패하는 정규식)를 넘겨 이중 안전장치를 둔다. 이 메커니즘은 `telnet-client`의 공개 문서화된 API가 아니라 내부 동작을 근거로 하므로, 라이브러리 버전을 올릴 때는 실제로 재검증할 것.

#### 시스템 설정 / 서비스 재시작

- `POST /api/system/restart` — 실행 중인 프로세스(패키징된 exe 또는 dev 서버)를 실제로 재시작한다. `(process as any).pkg`가 있으면(pkg exe) 인자 없이 `process.execPath`를 그대로 재실행, 없으면(`tsx server.ts` 개발 모드) `process.execArgv`(tsx가 `--require`/`--import`로 등록하는 플래그들, `process.argv`에는 없음) + `process.argv.slice(1)`을 함께 넘겨 재실행해야 한다 — `execArgv`를 빼먹으면 TypeScript를 못 읽어서 자식 프로세스가 조용히 죽는다. `cwd: process.cwd()`로 같은 작업 디렉터리를 유지하고, 응답을 먼저 보낸 뒤 약간의 딜레이 후 종료한다. `SystemSettings.tsx`의 "서버 초기화" 버튼 바로 아래에 "서비스 재시작" 버튼이 있다(클릭 시 확인창).
- 헤더 버전 배지(`App.tsx`)와 `package.json`의 `"version"`이 `v2.0.0`으로 갱신되어 있다.

### 프론트엔드 (`src/`)

- `src/App.tsx`가 최상위 상태(모든 도메인 모델의 React state)를 들고 있고, 탭(`dashboard | dhcp | files | terminal | settings`)에 따라 `src/components/` 아래의 대응 컴포넌트에 props로 내려준다. 전역 상태 관리 라이브러리는 쓰지 않는다.
- 도메인 타입은 `src/types.ts` 한 곳에 전부 정의되어 있고 프론트엔드/백엔드가 같은 타입 정의를 참조한다(`server.ts`가 `./src/types.js`를 import).
- 컴포넌트 구성: `Dashboard`(전체 상태 요약), `DhcpServer`(DHCP 설정/실단말 탐지/예약), `FileServer`(TFTP/FTP 파일 관리, 공유 폴더 편집), `TerminalAutomation`(SSH/Telnet 호스트 및 실제 스크립트 실행), `SystemSettings`.
- 스타일은 Tailwind CSS v4(`@tailwindcss/vite` 플러그인), 아이콘은 `lucide-react`, 애니메이션은 `motion` 사용.
- AI Studio 템플릿이 남겼던 흔적(`@google/genai`/`dotenv` 의존성, `.env.example`의 `GEMINI_API_KEY`/`APP_URL`, `metadata.json`, `index.html`의 "My Google AI Studio App" 타이틀, AI Studio 안내문이던 `README.md`, `vite.config.ts`의 `DISABLE_HMR` 분기)은 모두 제거됐다 — 이 앱은 Gemini API나 AI Studio 런타임과 무관하게 독립적으로 동작하며, `.env` 없이도 `npm run dev`/`build:exe` 모두 정상 동작한다.

## Windows EXE 빌드 시 아이콘 적용 (중요, 비직관적인 부분)

`package.json`의 `build:exe` 스크립트에 `pkg --icon assets/icon.ico` 옵션이 있지만, **여기서 사용하는 `pkg@5.8.1`(vercel/pkg, 유지보수 중단)은 `--icon` 플래그를 실제로 구현하지 않는다** — 조용히 무시되고 기본 pkg 아이콘(녹색 큐브)이 그대로 들어간다.

빌드 후 `rcedit`로 완성된 exe의 아이콘을 직접 바꾸는 것도 **동작하지 않는다**: pkg는 자신이 내려받은 base Node 바이너리 뒤에 payload(가상 파일시스템 + 바이트코드)를 이어붙이고, 그 payload의 절대 오프셋을 **빌드 시점에 base 바이너리 안의 플레이스홀더 문자열에 직접 구워 넣는다**(런타임에 파일 끝에서 마커를 찾는 방식이 아님). `rcedit`가 PE 리소스(아이콘)를 다시 쓰면서 파일의 앞부분 레이아웃이 바뀌면 이 하드코딩된 오프셋이 어긋나 `Pkg: Error reading from file.` 오류로 즉시 크래시한다.

**검증된 해결 절차** (pkg의 로컬 의존성인 `pkg-fetch@3.4.2`가 `~/.pkg-cache/v3.4/built-<nodeVersion>-<platform>-<arch>` 파일이 존재하면 해시 검증 없이 그대로 신뢰한다는 점을 이용):

1. `npm install --no-save rcedit` (Electron 팀의 `rcedit-x64.exe`를 번들한 npm 패키지)
2. pkg가 이미 받아둔 pristine base 바이너리를 복사: `~/.pkg-cache/v3.4/fetched-v18.5.0-win-x64` → 별도 경로에 복사
3. 그 복사본에만 `rcedit-x64.exe <복사본> --set-icon assets/icon.ico` 실행 (최종 exe나 캐시의 `fetched-*` 파일에는 절대 실행하지 말 것)
4. `~/.pkg-cache/v3.4/fetched-v18.5.0-win-x64` 원본을 삭제(또는 이름 변경)하고, 아이콘 입힌 복사본을 `~/.pkg-cache/v3.4/built-v18.5.0-win-x64` 이름으로 그 자리에 둔다 — `fetched-*`가 존재하면 해시가 맞는 한 `built-*`를 아예 확인하지 않으므로 반드시 `fetched-*`를 없애야 한다.
5. 평소처럼 `pkg . --targets node18-win-x64 --output network_server_suite.exe` 실행 (이제 `pkg-fetch`가 `built-*`를 찾아 그대로 사용).
6. 빌드가 끝나면 `~/.pkg-cache/v3.4`를 원래 상태로 복원(주입한 `built-*` 삭제, `fetched-*` 복구)해서 이 머신의 다른 pkg 프로젝트에 영향을 주지 않도록 한다.

참고로 유지보수되는 포크인 `@yao-pkg/pkg`도 시도해봤으나: (a) CLI에 `--icon` 옵션 자체가 없고, (b) 그쪽의 `pkg-fetch`가 기대하는 base 바이너리 패치 버전이 vercel/pkg의 것과 달라 두 툴체인을 섞어 쓰면(`@yao-pkg/pkg` + vercel `pkg-fetch`가 받아온 바이너리) `ERR_INVALID_ARG_TYPE ... promisify` 같은 prelude 부트스트랩 오류로 크래시한다. 아이콘 문제는 결국 **원래 쓰던 `pkg@5.8.1` 툴체인 내부에서, 위 `built-*` 캐시 트릭으로** 해결해야 한다.

**참고(Tip)**: `ssh2`/`telnet-client` 추가 이후 `build:exe`(pkg 패키징)까지 실제로 재빌드해서 검증 완료했다. 이 프로젝트의 `ssh2`는 선택적 네이티브 애드온(`cpu-features`)이 설치되어 있지 않아 순수 JS 폴백으로 동작하며, `telnet-client`도 네이티브 `.node` 바이너리가 없다 — 그래서 pkg의 가상 파일시스템과 충돌 없이 정상 패키징됐다. 다만 `npm install`을 다시 하거나 의존성 버전이 바뀌어 `cpu-features`(네이티브 애드온)가 실제로 설치되는 상황이 생기면, pkg가 네이티브 `.node` 바이너리를 제대로 못 담을 수 있으니 그때는 `node_modules/cpu-features`가 존재하는지부터 확인할 것. `ftp-srv`(및 그 의존성인 `bunyan`의 선택적 네이티브 애드온 `dtrace-provider`)도 마찬가지로 `.node` 바이너리 없이 순수 JS 폴백으로 패키징되는 것을 확인했다 — `node_modules/dtrace-provider`에 `.node` 파일이 없으면 안전하다.

### `assets/icon.ico`

3개의 서버랙 바(LED 포함) + 상단 네트워크 신호 아치 모티프의 아이콘(16~256px 다중 해상도)이 이미 생성되어 있다. 재생성이 필요하면 GDI+(`System.Drawing`)로 직접 그려 표준 BMP(DIB) 프레임으로 인코딩해야 한다 — PNG 압축 프레임 방식은 `.NET`의 `System.Drawing.Icon` 로더와 일부 구형 도구에서 파싱에 실패하는 것을 확인했다.
