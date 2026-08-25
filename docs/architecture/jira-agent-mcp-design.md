# Jira Agent MCP — 종합 설계도

> **목표:** 빠른 스트레이트 개발 + 내부 복잡성 수용 + 외부 단순성 + 즉시 팀 도입  
> **핵심 원칙:** **설계는 V3 기준, 구현은 V1 범위, 외부 계약은 처음부터 고정한다.**

---

## 1. 배경

Claude Code / Codex에서 Atlassian Jira MCP를 직접 사용할 경우 다음 비용이 반복적으로 발생할 수 있다.

- JQL 검색 결과에 불필요한 필드가 포함되어 payload가 커짐
- `description`, `comments` 등 장문 데이터가 discovery 단계부터 모델 context에 유입됨
- 여러 이슈를 개별 조회하면서 원격 왕복이 누적됨
- MCP tool result를 모델이 다시 읽고 추론하는 비용이 커짐
- 일부 클라이언트에서는 Jira widget / rich UI 렌더링 비용까지 추가됨
- Claude Code와 Codex가 각자 다른 방식으로 Jira를 조회하면 팀 단위 조회 정책이 일관되지 않음
- 검색 최적화를 과도하게 적용하면 comments, custom fields, dependencies 등을 놓쳐 업무 판단 오류가 발생할 수 있음

따라서 Jira를 직접 노출하기보다 Claude Code / Codex와 Jira 사이에 **Agent 전용 Jira Access Layer**를 둔다.

---

# 2. 최종 목표

사용자에게 보이는 경험은 최대한 단순해야 한다.

```text
프로젝트 clone
    ↓
setup 실행
    ↓
Jira 인증 최초 1회
    ↓
Claude Code / Codex 실행
    ↓
평소처럼 자연어로 Jira 질문
```

예:

```text
> 지금 내가 처리해야 할 Jira 이슈 확인해
> #101 착수 가능한지 봐
> FE blocker 기준으로 다음 작업 우선순위 정해
> #97에서 합의된 내용 확인해
```

사용자는 다음을 몰라도 된다.

- JQL 필드 선택
- pagination
- comments 조회 시점
- custom field 선택
- Jira REST endpoint
- Rovo MCP
- cache
- output token budget
- consistency / stale-read 처리

이 복잡성은 모두 `jira-agent-mcp` 내부에서 처리한다.

---

# 3. 핵심 아키텍처

```text
┌──────────────────────────────────────────────┐
│              Claude Code / Codex             │
└──────────────────────┬───────────────────────┘
                       │
                       │ MCP
                       ▼
┌──────────────────────────────────────────────┐
│                jira-agent-mcp                │
│                                              │
│  External Tools                              │
│  ├─ jira_search                              │
│  ├─ jira_context                             │
│  └─ jira_full                                │
│                                              │
│  Application                                 │
│  ├─ SearchIssues                             │
│  ├─ GetIssueContext                          │
│  └─ GetFullIssueContext                      │
│                                              │
│  Policy                                      │
│  ├─ FieldPolicy                              │
│  ├─ PaginationPolicy                         │
│  ├─ CompletenessPolicy                       │
│  ├─ OutputBudgetPolicy                       │
│  └─ ConsistencyPolicy                        │
│                                              │
│  Ports                                       │
│  ├─ JiraReadPort                             │
│  ├─ JiraWritePort                            │
│  ├─ CachePort                                │
│  ├─ CredentialPort                           │
│  └─ TelemetryPort                            │
│                                              │
│  Adapters                                    │
│  ├─ Jira Cloud REST                          │
│  ├─ Noop/SQLite/Remote Cache                 │
│  ├─ Env/OAuth Credentials                    │
│  └─ Console/OTel Telemetry                   │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
                    Jira Cloud
```

---

# 4. 설계 원칙

## 4.1 외부는 3개 Tool만 노출

Claude Code / Codex가 볼 Jira read tool은 다음 3개로 고정한다.

1. `jira_search`
2. `jira_context`
3. `jira_full`

외부 Tool 계약은 초기부터 안정적으로 유지한다.

내부 구현이 향후 다음처럼 바뀌어도 Tool 계약은 바꾸지 않는다.

```text
Jira REST
   ↓
REST + Local Cache
   ↓
REST + Rovo fallback
   ↓
Remote MCP + Redis
```

---

## 4.2 Agent에게 Jira 최적화 책임을 맡기지 않는다

다음 항목을 Agent가 직접 결정하게 하지 않는다.

- Jira `fields`
- raw `maxResults`
- pagination
- comments 조회 여부
- output truncation
- cache 사용 여부
- stale-read 방지 방식

Claude / Codex는 목적만 표현한다.

```text
목록이 필요하다
착수 판단이 필요하다
최종 합의 판단이 필요하다
```

세부 조회 정책은 MCP 내부 코드가 강제한다.

---

## 4.3 Search는 가볍게, 판단은 충분히

전체 정책:

```text
Search Lite
    ↓
후보 선별
    ↓
Context
    ↓
필요 시 Full
    ↓
최종 판단
```

즉:

> **정보를 버리는 것이 아니라, 필요한 시점까지 읽지 않는다.**

---

## 4.4 Silent truncation 금지

결과가 너무 크거나 일부 정보를 읽지 못한 경우 조용히 잘라내지 않는다.

반드시 결과 metadata에 표시한다.

```json
{
  "meta": {
    "complete": false,
    "reason": "OUTPUT_BUDGET",
    "overflow": "comments"
  }
}
```

---

## 4.5 Jira는 계속 SSOT

Local cache / snapshot은 성능 최적화 계층일 뿐 정본이 아니다.

```text
Jira = Canonical Source
Cache = Read Optimization
```

---

# 5. 외부 Tool 계약

---

## 5.1 `jira_search`

### 목적

다음과 같은 **탐색 / 목록 / 현황 파악**에 사용한다.

- 열린 이슈 조회
- 담당 이슈 조회
- 특정 label / component 이슈 조회
- 최근 변경 이슈 조회
- 후보 작업 추출

### 입력

```ts
type JiraSearchInput = {
  jql: string;
  scope?: "preview" | "complete";
};
```

### 기본 정책

`scope = "preview"`

- 빠른 첫 페이지 반환
- interactive 탐색용

`scope = "complete"`

- `nextPageToken`이 끝날 때까지 서버 내부에서 pagination 처리
- 전체 열거가 필요한 경우 사용

### 반환 필드

기본 Lite 필드:

```text
key
summary
status
assignee
priority
updated
labels
components
```

`description`, `comments`, `attachments`, `changelog`는 반환하지 않는다.

### 출력 예시

```json
{
  "issues": [
    {
      "key": "PROJECT-101",
      "summary": "Example issue",
      "status": "Open",
      "assignee": "CURRENT_USER",
      "priority": "High",
      "updated": "2026-08-25T12:00:00+09:00",
      "labels": ["front"],
      "components": []
    }
  ],
  "meta": {
    "level": "search",
    "complete": true,
    "pagesFetched": 1
  }
}
```

---

## 5.2 `jira_context`

### 목적

다음과 같은 **행동 가능성 / 의존성 판단**에 사용한다.

- 지금 착수 가능한가
- blocker가 있는가
- 어떤 이슈를 먼저 해야 하는가
- parent/subtask 관계가 있는가
- 타 파트 의존성이 있는가

### 입력

```ts
type JiraContextInput = {
  issueKeys: string[];
};
```

### Batch 지원

한 번에 여러 이슈를 받는다.

```text
jira_context([
  "PROJECT-97",
  "PROJECT-101",
  "PROJECT-108"
])
```

개별 원격 호출 반복을 최소화한다.

### 반환 정보

Lite 필드에 추가:

```text
parent
subtasks
issueLinks
dependency / blocker 관계
components
project-specific custom fields
```

### comments

기본적으로 전체 comments는 읽지 않는다.

단, CompletenessPolicy에서 해당 프로젝트의 readiness 판단에 특정 comment 기반 필드가 필수라고 선언한 경우 예외적으로 escalation할 수 있다.

---

## 5.3 `jira_full`

### 목적

다음과 같은 **최종 판단**에 사용한다.

- 합의가 끝났는가
- 계약이 확정됐는가
- 상대 파트의 최신 답변이 무엇인가
- Done 처리 가능한가
- 승인되었는가
- 이슈의 현재 의미를 최종적으로 해석해야 하는가

### 입력

```ts
type JiraFullInput = {
  issueKeys: string[];
};
```

### 반환 정보

```text
summary
status
assignee
priority
description
comments
parent
subtasks
issueLinks
project-specific custom fields
필요 시 relevant changelog
```

### 원칙

`jira_search` 결과만으로 다음을 확정하지 않는다.

- agreement
- contract
- approval
- closure
- cross-team final decision

---

# 6. Completeness Metadata

모든 Tool 결과에는 조회 완결성 정보를 포함한다.

```ts
type CompletenessMeta = {
  level: "search" | "context" | "full";
  complete: boolean;

  pagesFetched?: number;
  fieldsLoaded?: string[];

  commentsComplete?: boolean;
  linksComplete?: boolean;

  fetchedAt: string;

  reason?:
    | "OUTPUT_BUDGET"
    | "PERMISSION"
    | "PARTIAL_API_RESPONSE"
    | "UNKNOWN";
};
```

목적:

> Agent가 현재 결과가 전체 맥락인지 일부 맥락인지 명확히 알 수 있도록 한다.

---

# 7. Policy Layer

---

## 7.1 FieldPolicy

Context Level에 따라 Jira API 필드를 강제한다.

```text
SEARCH
  summary
  status
  assignee
  priority
  updated
  labels
  components

CONTEXT
  SEARCH fields
  + parent
  + subtasks
  + issuelinks
  + whitelisted custom fields

FULL
  CONTEXT fields
  + description
  + comments
  + conditional history
```

Agent가 임의로 `fields=*`를 요청할 수 없다.

---

## 7.2 PaginationPolicy

### Preview

```text
첫 페이지 반환
```

목적:

- 후보 탐색
- 대화형 조회
- 빠른 응답

### Complete

```text
page 1
 ↓ nextPageToken
page 2
 ↓
...
 ↓
END
```

전체 enumeration이 필요한 경우 모든 page를 내부에서 순회한다.

절대 다음 형태로 판단하지 않는다.

```text
maxResults = 20
→ 20건 반환
→ 전체가 20건이라고 판단
```

---

## 7.3 CompletenessPolicy

업무 판단 종류에 따라 최소 조회 level을 정의한다.

```text
LIST / DISCOVERY
→ SEARCH

READINESS / BLOCKER / PRIORITY / DEPENDENCY
→ CONTEXT

AGREEMENT / CONTRACT / APPROVAL / CLOSURE
→ FULL
```

초기에는 복잡한 AI classifier를 구현하지 않는다.

- MCP Tool description
- Claude Code / Codex instruction
- 프로젝트 policy 설정

세 가지로 충분히 강제한다.

향후 필요할 경우 자동 Intent Router를 추가한다.

---

## 7.4 OutputBudgetPolicy

목표 output budget:

```text
Search  < 2k tokens
Context < 5k tokens
Full    < 8k tokens
```

절대값은 실측 후 조정한다.

### Jira ADF 처리

Jira ADF raw JSON을 그대로 Agent에게 보내지 않는다.

```text
ADF
 ↓
Normalized Plain Text
 ↓
Agent
```

불필요한 JSON 구조 토큰을 제거한다.

### Full 결과 overflow 시

우선순위:

1. 핵심 issue metadata
2. description
3. links / dependencies
4. comments
5. changelog
6. 기타 metadata

범위를 초과하면 silent truncation하지 않고 `meta.complete = false`로 표시한다.

---

## 7.5 ConsistencyPolicy

일반 read:

```text
Enhanced JQL Search
```

write 직후 read-after-write 확인:

```text
Direct Issue GET
또는
Jira reconciliation mechanism
```

write 직후 stale cache / 일반 JQL 결과만으로 성공 여부를 판정하지 않는다.

---

# 8. Domain Model

```ts
type ContextLevel =
  | "search"
  | "context"
  | "full";

type IssueSummary = {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  priority?: string;
  updated: string;
  labels: string[];
  components: string[];
};

type IssueContext = IssueSummary & {
  parent?: IssueRef;
  subtasks: IssueRef[];
  links: IssueLink[];
  customFields: Record<string, unknown>;
};

type FullIssueContext = IssueContext & {
  description?: string;
  comments: NormalizedComment[];
  history?: RelevantHistory[];
};
```

Jira API raw DTO를 Application Layer 밖으로 직접 노출하지 않는다.

---

# 9. Ports & Adapters

---

## 9.1 JiraReadPort

```ts
interface JiraReadPort {
  search(...): Promise<...>;
  getContexts(...): Promise<...>;
  getFullContexts(...): Promise<...>;
}
```

초기 구현:

```text
JiraCloudRestAdapter
```

향후:

```text
RovoAdapter
JiraDataCenterAdapter
MockAdapter
```

추가 가능.

---

## 9.2 JiraWritePort

초기 핵심 범위는 read optimization이다.

그러나 구조에는 write port를 미리 둔다.

```ts
interface JiraWritePort {
  updateIssue(...): Promise<...>;
  addComment(...): Promise<...>;
}
```

첫 배포에서는:

- 최소 구현
- 또는 명시적 Stub

중 하나를 선택한다.

기존 Atlassian MCP가 쓰기 fallback 역할을 수행할 수 있다.

---

## 9.3 CachePort

```ts
interface CachePort {
  get(...): Promise<...>;
  set(...): Promise<void>;
  invalidate(...): Promise<void>;
}
```

첫 배포:

```text
NoopCache
```

향후:

```text
MemoryCache
SQLiteCache
RedisCache
```

로 교체한다.

Application 코드는 변경하지 않는다.

---

## 9.4 CredentialPort

초기:

```text
EnvironmentCredentialAdapter
```

필요 환경 변수:

```text
JIRA_BASE_URL
JIRA_EMAIL
JIRA_API_TOKEN
```

향후:

```text
OAuthCredentialAdapter
```

로 교체 가능.

Credential은 Git에 저장하지 않는다.

---

## 9.5 TelemetryPort

첫 배포:

```text
ConsoleTelemetry
```

stderr에 최소 metric 기록:

```text
tool=jira_search
duration_ms=831
jira_requests=1
issues=17
response_bytes=7421
pages=1
```

향후:

```text
OpenTelemetry
Prometheus
Dashboard
```

등으로 교체 가능.

---

# 10. 에러 모델

Jira raw error를 Agent에게 그대로 전달하지 않는다.

정규화된 error code 사용:

```text
JIRA_AUTH_FAILED
JIRA_PERMISSION_DENIED
JQL_INVALID
ISSUE_NOT_FOUND
RATE_LIMITED
CONTEXT_TOO_LARGE
PARTIAL_RESULT
CONFIG_INVALID
JIRA_UNAVAILABLE
```

예:

```json
{
  "error": {
    "code": "JIRA_PERMISSION_DENIED",
    "message": "Current Jira account cannot view PROJECT-103."
  }
}
```

Credential / Authorization header / token은 로그와 tool result에 절대 출력하지 않는다.

---

# 11. Repository 구조

## 11.1 `jira-agent-mcp` 공용 레포

```text
jira-agent-mcp/
│
├─ src/
│  ├─ mcp/
│  │  ├─ create-server.ts
│  │  ├─ stdio.ts
│  │  └─ tools/
│  │     ├─ jira-search.tool.ts
│  │     ├─ jira-context.tool.ts
│  │     └─ jira-full.tool.ts
│  │
│  ├─ application/
│  │  ├─ search-issues.ts
│  │  ├─ get-issue-context.ts
│  │  └─ get-full-issue-context.ts
│  │
│  ├─ domain/
│  │  ├─ issue.ts
│  │  ├─ context.ts
│  │  └─ completeness.ts
│  │
│  ├─ policy/
│  │  ├─ field-policy.ts
│  │  ├─ pagination-policy.ts
│  │  ├─ completeness-policy.ts
│  │  ├─ output-budget-policy.ts
│  │  └─ consistency-policy.ts
│  │
│  ├─ ports/
│  │  ├─ jira-read.port.ts
│  │  ├─ jira-write.port.ts
│  │  ├─ cache.port.ts
│  │  ├─ credentials.port.ts
│  │  └─ telemetry.port.ts
│  │
│  ├─ adapters/
│  │  ├─ jira-cloud/
│  │  │  ├─ jira-client.ts
│  │  │  ├─ jira-read.adapter.ts
│  │  │  ├─ jira-write.adapter.ts
│  │  │  ├─ adf-to-text.ts
│  │  │  └─ mapper.ts
│  │  │
│  │  ├─ cache/
│  │  │  └─ noop-cache.ts
│  │  │
│  │  ├─ telemetry/
│  │  │  └─ console-telemetry.ts
│  │  │
│  │  └─ credentials/
│  │     └─ env-credentials.ts
│  │
│  ├─ config/
│  │  ├─ schema.ts
│  │  └─ load-config.ts
│  │
│  └─ index.ts
│
├─ tests/
│  ├─ unit/
│  ├─ contract/
│  ├─ integration/
│  └─ benchmark/
│
├─ scripts/
│  ├─ setup.ps1
│  └─ doctor.ts
│
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## 11.2 각 프로젝트 레포

예: target-project

```text
target-project/
├─ .mcp.json
├─ .jira-agent/
│  └─ project.yaml
├─ CLAUDE.md
├─ AGENTS.md
└─ ...
```

프로젝트 레포에는 Jira Agent 구현을 넣지 않는다.

프로젝트별 정책만 저장한다.

---

# 12. 프로젝트 설정

예:

```yaml
version: 1

project:
  key: PROJECT

search:
  pageSize: 20

fields:
  lite:
    - summary
    - status
    - assignee
    - priority
    - updated
    - labels
    - components

  context:
    - parent
    - subtasks
    - issuelinks

customFields: []

policy:
  contextRequiredFor:
    - readiness
    - dependency
    - blocker
    - priority

  fullRequiredFor:
    - agreement
    - contract
    - approval
    - closure
```

### 보안

다음은 프로젝트 설정에 넣지 않는다.

```text
API token
password
OAuth secret
cookie
Authorization header
```

---

# 13. Claude Code 사용 정책

`CLAUDE.md`에는 복잡한 Jira API 규칙을 복붙하지 않는다.

최소 행동 규칙만 둔다.

```text
For Jira reads, use jira-agent tools.

- Discovery/listing → jira_search
- Readiness/blocker/dependency/priority → jira_context
- Agreement/contract/approval/closure → jira_full

Do not use raw Atlassian Jira search when jira-agent can satisfy the request.
Search results must not be treated as complete issue context.
```

---

# 14. 기존 Atlassian MCP와 관계

초기 도입:

```text
Claude Code
│
├─ jira-agent-mcp
│   └─ Jira READ 기본 경로
│
└─ Atlassian MCP
    ├─ Confluence
    ├─ 미지원 Jira 기능
    └─ fallback
```

기존 Atlassian MCP를 즉시 제거하지 않는다.

그러나 Jira read는 새 MCP가 기본 진입점이 되도록 한다.

이렇게 해야 도입 즉시:

- JQL payload 축소
- tool result token 축소
- 불필요한 widget / rich result 경로 감소
- 팀 단위 조회 정책 일관성

효과를 얻을 수 있다.

---

# 15. 팀 설치 UX

초기 팀 도입은 다음 한 줄을 목표로 한다.

```powershell
./scripts/setup-jira-agent.ps1
```

스크립트 역할:

```text
Node 버전 확인
jira-agent 설치/업데이트
npm ci
build
환경 변수 확인
Jira 인증 테스트
project config 검증
doctor 실행
```

성공 출력 예:

```text
[OK] Node 20+
[OK] jira-agent build
[OK] Project config
[OK] Jira authentication
[OK] PROJECT access
[OK] MCP executable
```

그 후:

```text
claude
```

실행.

최초 project MCP 승인 후 평소처럼 사용한다.

---

# 16. Doctor

반드시 제공한다.

```text
jira-agent doctor
```

검증:

```text
Node runtime
Project config
Credential presence
Jira base URL
Jira authentication
Project permission
JQL search endpoint
Issue detail endpoint
MCP stdio startup
```

목표:

> MCP 문제인지 Jira 문제인지 환경 문제인지 즉시 구분한다.

---

# 17. 구현 전략

## 핵심 원칙

> **추상화부터 모두 만드는 것이 아니라, 수직 슬라이스를 먼저 관통한 후 계층을 확장한다.**

금지:

```text
Port만 10개 작성
Adapter 없음
실제 Jira 호출 없음
MCP 실행 안 됨
```

권장:

```text
Domain
 ↓
JiraReadPort
 ↓
Jira REST Adapter
 ↓
Search Application
 ↓
MCP Tool
 ↓
Claude Code 실호출
```

를 가장 먼저 관통한다.

---

# 18. 스트레이트 개발 순서

## Phase A — Skeleton

구현:

- TypeScript 프로젝트
- MCP server bootstrap
- Domain / Ports / Adapters 디렉터리
- Config schema
- Error model

완료 기준:

```text
MCP server가 Claude Code에서 기동 가능
```

---

## Phase B — Jira REST

구현:

- CredentialPort
- Jira client
- 인증
- JQL search
- Issue GET
- ADF normalization

완료 기준:

```text
CLI/테스트에서 실제 Jira issue 조회 가능
```

---

## Phase C — `jira_search`

구현:

- Lite field whitelist
- preview / complete
- pagination
- normalized output
- completeness metadata
- telemetry

완료 기준:

```text
description/comments 없이 실제 검색 성공
pagination 누락 없음
```

---

## Phase D — `jira_context`

구현:

- batch keys
- parent
- subtasks
- issueLinks
- dependencies
- custom field whitelist

완료 기준:

```text
착수/blocker/priority 판단에 필요한 정보 확보
```

---

## Phase E — `jira_full`

구현:

- description
- comments
- relevant history
- ADF → text
- output budget
- completeness metadata

완료 기준:

```text
합의/계약/완료 판단 가능한 정보 확보
silent truncation 없음
```

---

## Phase F — Policy

구현:

- FieldPolicy
- PaginationPolicy
- CompletenessPolicy
- OutputBudgetPolicy
- ConsistencyPolicy

주의:

각 policy는 이미 동작 중인 수직 경로를 감싸는 방식으로 추가한다.

---

## Phase G — Project Integration

구현:

- `.mcp.json`
- `.jira-agent/project.yaml`
- `CLAUDE.md`
- `AGENTS.md`

완료 기준:

```text
target-project clone 환경에서 Claude Code 실제 사용
```

---

## Phase H — Team Setup

구현:

- setup script
- doctor
- README 최소 사용법

완료 기준:

```text
새 팀원이 저장소 내부 구조를 몰라도 설치 가능
```

---

## Phase I — Benchmark

기존 Atlassian MCP와 동일한 대표 workload를 비교한다.

---

# 19. 첫 배포에 반드시 구현

```text
Jira REST client
Credential boundary
jira_search
jira_context
jira_full
pagination
field whitelist
batch context
comments escalation
ADF normalization
output budget
completeness metadata
project config
normalized errors
minimal telemetry
setup script
doctor
Claude Code integration
Codex integration contract
tests
```

---

# 20. 첫 배포에서는 인터페이스만 확보

다음은 구조에는 자리를 두되 구현을 깊게 하지 않는다.

```text
CachePort        → NoopCache
TelemetryPort    → ConsoleTelemetry
JiraWritePort    → 최소 또는 Stub
Remote Transport → 후순위
```

---

# 21. 첫 배포에서 하지 않음

```text
Redis
PostgreSQL
Remote MCP 운영 서버
OAuth authorization server
Rovo adapter 실구현
Semantic cache
AI intent classifier
Telemetry dashboard
Plugin marketplace packaging
복잡한 background sync
```

이 항목은 스트레이트 개발을 방해하므로 후순위로 둔다.

---

# 22. 테스트 전략

## 22.1 Unit

대상:

- FieldPolicy
- PaginationPolicy
- OutputBudgetPolicy
- ADF normalization
- Error mapping
- config validation

---

## 22.2 Contract

검증:

```text
jira_search input/output
jira_context input/output
jira_full input/output
CompletenessMeta
Normalized Error
```

외부 Tool contract 변경 방지.

---

## 22.3 Integration

실제 또는 test Jira 환경에서 검증:

```text
JQL
pagination
issue links
comments
permissions
custom fields
rate limit
```

---

## 22.4 Critical Regression

다음은 배포 blocker다.

### Pagination

```text
전체 검색에서 page 누락 0
```

### Completeness

```text
partial result를 complete로 표시하는 경우 0
```

### Security

```text
credential / authorization 로그 유출 0
```

### Full Context

```text
합의 판단에 comments 누락 0
```

---

# 23. Benchmark

기존 Atlassian MCP를 baseline 100으로 둔다.

측정:

```text
jira_calls_per_task
jira_round_trip_ms
tool_result_bytes
tool_result_tokens
issues_returned
pages_fetched
agent_time_to_next_action
```

Correctness:

```text
missed_issue_count
stale_read_count
missed_comment_decision
missed_dependency
false_ready_decision
false_done_decision
```

---

# 24. 첫 배포 성능 목표

절대 ms보다 기존 경로 대비 비율을 우선한다.

```text
Search payload      ≤ baseline 30%
Search tool tokens  ≤ baseline 30%
Jira latency        ≤ baseline 60%
Critical omission   = 0
Silent truncation   = 0
```

초기 최우선 목표는:

> **payload / token을 크게 줄이면서 correctness를 유지하는 것**

이다.

Cache는 그 이후 latency를 더 낮추는 단계다.

---

# 25. 후속 확장

초기:

```text
Claude / Codex
     ↓
Local stdio MCP
     ↓
NoopCache
     ↓
Jira REST
```

후속:

```text
Claude / Codex
     ↓
Remote MCP
     ↓
Memory / SQLite / Redis
     ↓
REST / Rovo Routing
     ↓
Jira
```

외부 Tool은 계속 동일하다.

```text
jira_search
jira_context
jira_full
```

---

# 26. 팀 공용 구조

```text
Developer A Claude ─┐
Developer B Claude ─┤
Developer C Codex ──┼── jira-agent-mcp ── Jira
Developer D Codex ──┘
```

초기에는 각 팀원이 local MCP를 실행할 수 있다.

안정화 후 Remote MCP로 이동 가능하다.

중요:

```text
공용 = 로직 / 정책
개별 = Jira 인증 / 권한
```

공용 Jira service account 하나로 모든 사용자의 권한을 통합하지 않는다.

---

# 27. 저장 구조

## Git 추적

```text
jira-agent source
Tool contracts
Policy
Project config
Tests
Setup scripts
Claude / Codex instructions
```

## Git 비추적

```text
Jira API token
OAuth secret
local cache
runtime DB
logs containing sensitive data
```

예:

```gitignore
.jira-agent/cache/
.env
*.local.db
```

---

# 28. 완료 정의

첫 실사용 가능한 버전은 다음 조건을 모두 충족해야 한다.

- [ ] `jira_search`가 실제 Jira에서 동작한다.
- [ ] Search에서 `description/comments`가 기본 반환되지 않는다.
- [ ] Complete 검색의 pagination 누락이 없다.
- [ ] `jira_context`가 blocker / dependency 판단 정보를 반환한다.
- [ ] `jira_full`이 description / comments를 포함한다.
- [ ] Full 결과가 너무 클 경우 silent truncation하지 않는다.
- [ ] 모든 결과에 completeness metadata가 존재한다.
- [ ] Jira credential이 Git / 로그 / Tool output에 유출되지 않는다.
- [ ] Claude Code에서 실제 MCP 호출이 성공한다.
- [ ] Codex에서 동일한 Tool contract를 사용할 수 있다.
- [ ] 팀원이 setup + 인증만으로 사용 가능하다.
- [ ] `doctor`로 환경 문제를 진단할 수 있다.
- [ ] 기존 Atlassian MCP 대비 payload / token 개선을 실측했다.
- [ ] Critical information omission이 검증 workload에서 0건이다.

---

# 29. 핵심 의사결정 요약

| 항목 | 결정 |
|---|---|
| 핵심 결과물 | `jira-agent-mcp` 별도 공용 레포 |
| 언어 | TypeScript / Node.js |
| 외부 Tool | `jira_search`, `jira_context`, `jira_full` |
| Jira 기본 연결 | Jira Cloud REST API |
| 기존 Atlassian MCP | Confluence / fallback 유지 |
| Jira read 기본 경로 | `jira-agent-mcp` |
| Search | Lite fields 강제 |
| Context | dependencies / links 중심 |
| Full | description / comments 포함 |
| Pagination | MCP 내부 책임 |
| 결과 누락 | silent truncation 금지 |
| Cache | 첫 버전 Noop, Port는 유지 |
| 인증 | 사용자별 credential |
| 팀 설정 | 프로젝트 레포 `project.yaml` |
| 사용자 UX | setup → 인증 → 자연어 사용 |
| 아키텍처 방향 | Ports & Adapters |
| 개발 방식 | 수직 슬라이스 기반 스트레이트 개발 |
| 최우선 검증 | pagination / completeness / credential leakage |
| 장기 확장 | cache / Remote MCP / Rovo routing |

---

# 30. 최종 원칙

이 프로젝트는 **간단한 Jira wrapper**가 아니다.

목표는 다음과 같다.

> Claude Code와 Codex가 Jira를 자주 사용하더라도 평상시에는 원격 조회 비용이 최소화되고, 중요한 업무 판단 시점에는 충분한 컨텍스트가 자동으로 확보되며, 모든 팀원이 동일한 완결성·성능 정책을 적용받게 한다.

따라서 구현 원칙은 다음 네 가지로 고정한다.

### 1. 빠르게 만든다

실제 Jira → MCP → Claude Code를 가장 먼저 관통한다.

### 2. 내부는 복잡해도 된다

Policy / Ports / Adapters / Completeness / Telemetry 경계를 처음부터 둔다.

### 3. 외부는 단순해야 한다

사용자는 세 Tool과 자연어만 본다.

```text
jira_search
jira_context
jira_full
```

### 4. 바로 사용 가능해야 한다

```text
clone
→ setup
→ Jira 인증
→ Claude Code / Codex
```

이 흐름을 첫 배포 완료 조건으로 본다.

---

## 구현 슬로건

> **V3 Architecture, V1 Implementation, Stable External Contract.**
