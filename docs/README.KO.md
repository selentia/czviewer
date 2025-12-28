# CZ MultiViewer Extension (한국어)

**여러 치지직(CHZZK) 라이브 방송을 한 화면에서 시청할 수 있도록 도와주는 Chrome 확장 프로그램입니다.**

> [!NOTE]
> 이 문서는 CZ MultiViewer **Chrome 확장 프로그램**에 대한 한국어 설명입니다.  
> 웹 서비스나 서버, 배포 인프라에 대한 내용은 포함하지 않습니다.

📄 **다른 언어**:
- [🇺🇸 English](../README.md)

---

## 개요

CZ MultiViewer Extension은 브라우저에서 여러 치지직(CHZZK) 라이브 방송을
한 화면으로 시청할 수 있도록 도와주는 Chrome 확장 프로그램입니다.

멀티 스트림 시청에 필요한 기능들을 별도의 프로그램 없이 바로 사용할 수 있으며,
가볍게 동작하는 클라이언트 전용 확장 프로그램으로 구성되어 있습니다.

Chrome Extension Manifest V3 환경에서 동작합니다.

---

## 주요 기능

- 여러 치지직 라이브 방송 동시 시청 지원
- CZ MultiViewer 웹 페이지와의 연동
- 방송 간 레이턴시(지연 시간) 표시
- 치지직 로그인 기반 채팅 보조 기능 (확장 프로그램을 통해 제공)
- 단순하고 최소한의 확장 프로그램 팝업 UI

---

## 이 저장소의 범위

이 저장소에는 다음 내용만 포함되어 있습니다.

- Chrome 확장 프로그램 소스 코드 (Manifest V3)
- Background / Content Script
- 확장 프로그램 팝업 UI
- 확장 프로그램에서 사용되는 정적 자산 (아이콘 등)

다음 항목은 **의도적으로 포함하지 않습니다**.

- 웹 애플리케이션 소스 코드
- 서버 / 백엔드 API
- 난독화 또는 실제 서비스 배포용 스크립트

> 이 저장소는 **확장 프로그램 자체에만 집중**하기 위해 분리되어 있습니다.

---

## 프로젝트 구조

```text
.
├─ src/
│  ├─ background/    # Background 스크립트
│  ├─ content/       # Content 스크립트
│  ├─ popup/         # 확장 프로그램 팝업 UI
│  ├─ shared/        # 공용 유틸 및 메시지 정의
│  └─ types/         # TypeScript 타입 정의
├─ public/           # 확장 프로그램 자산 (아이콘, UI 이미지)
├─ manifest.json
├─ rules.json
├─ tsconfig.json
├─ tsup.config.ts
└─ package.json
```

---

## 빌드 방법

이 저장소는 **tsup**을 사용하여 번들링합니다.

```bash
npm install
npm run build
```

빌드 결과물은 다음 경로에 생성됩니다.

```text
dist/extension/
```

> [!NOTE]
> 빌드 산출물(`dist/`)은 저장소에 커밋되지 않습니다.

---

## 설치 방법

이미 배포된 확장 프로그램은 Chrome 웹 스토어에서 설치할 수 있습니다.

👉 **Chrome Web Store**  
https://chromewebstore.google.com/detail/cz-multiviewer/lnpfojaeffcahabkhdahkhcnpbgkigai

---

## 참고 사항

- 본 확장 프로그램은 **클라이언트 전용**으로 동작합니다.
- 기본 기능 사용을 위해 별도의 서버는 필요하지 않습니다.
- ESLint 및 Prettier 설정은 코드 스타일 유지를 위한 용도로 포함되어 있으며,
  로컬 개발 환경(에디터) 기준으로만 적용됩니다.

---

## 라이선스

MIT License  
© selentia

> [!NOTE]
> 일부 UI 자산(예: 서비스 로고)은 각 서비스의 브랜드 라이선스를 따릅니다.  
> 자세한 내용은 `public/NOTICE.md`를 참고하세요.
