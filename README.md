# Network Server Suite

DHCP/TFTP/FTP 서비스를 관리하고, SSH/Telnet 자동화 터미널 및 네트워크 로그 콘솔을 제공하는 웹 대시보드입니다.

- 백엔드: Express (`server.ts`, 단일 파일). 상태는 메모리 + 실행 폴더의 `applet_state.json`/`setting.ini`에 저장됩니다.
- 프론트엔드: React (`src/`), 1.5초 간격 REST 폴링으로 갱신됩니다.
- 실제 동작하는 DHCP 서버(DORA), TFTP/FTP 파일 공유, SSH/Telnet 원격 자동화를 포함합니다.

## 로컬 실행

**요구 사항:** Node.js

```
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## 빌드

```
npm run build       # 프론트엔드(vite) + 백엔드(esbuild) 번들
npm run build:exe   # Windows용 단일 실행 파일(network_server_suite.exe) 생성
npm run start        # 빌드된 dist/server.cjs를 node로 직접 실행
```

## 배포판 다운로드

Windows용 단일 실행 파일은 [Releases](https://github.com/kms6402-collab/network-server-suite/releases)에서 받을 수 있습니다. 관리자 권한으로 실행해야 DHCP 서버(UDP 67) 및 네트워크 어댑터 설정 기능이 정상 동작합니다.

## 개발 문서

프로젝트 아키텍처, 주의사항 등 자세한 내용은 [`CLAUDE.md`](./CLAUDE.md)를 참고하세요.
