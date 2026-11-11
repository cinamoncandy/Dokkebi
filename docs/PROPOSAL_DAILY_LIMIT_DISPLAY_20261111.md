# 제안: 하루 매수 한도로 거절된 주문을 "주문 실패"와 구분해서 보여주기

작성: 2026-11-11 · 상태: 제안(코드 변경 없음) · 한도, 위험, 자본, 권한은 바꾸지 않음

## 문제
서버 /health가 주문 단계를 `ORDER_INTENT_FAILING`(주문 실패)으로 표시한다.
2026-11-11 15:15 KST 기준 이 표시의 실제 원인은 고장이 아니라 하루 매수 한도다.

- 결정 139건 중 138건이 `RISK:FAIL:MAX_DAILY_BUY_NOTIONAL`로 거절됐다.
- 1건은 `INVALID_ORDERBOOK_QUOTE`(호가 값 이상)였다.
- 한도는 소유자가 정한 값(1배에서 3배로 올린 결정, #2997)이고 정상 동작이다.

결과: 학습 판정(`learningLoopVerdict`)이 "FAILED, ORDER"로 보이고, 한도가 제 역할을 하는 것과 진짜 고장이 같은 모양으로 보인다.
진짜 고장(예: 호가 값 이상, 지갑 오류)이 한도 거절 뒤에 숨을 수도 있다.

## 제안
`orderStage`(apps/cloud/src/learningPipelineStage.ts)가 실패 원인을 나눠 읽는다.

| 읽은 값 | 지금 | 제안 |
|---|---|---|
| 실패 건수 중 `MAX_DAILY_BUY_NOTIONAL`이 전부 | ORDER_INTENT_FAILING | `ORDER_LIMIT_REACHED` (한도 도달, 정상) |
| 한도 아닌 실패가 하나라도 있음 | ORDER_INTENT_FAILING | 그대로 ORDER_INTENT_FAILING |
| 실패 0건, 주문 0건 | ORDER_NONE | 그대로 |

원칙: 한도 도달은 "막힘"이 아니라 "대기"로 읽는다. 다만 한도가 아닌 실패가 섞이면 반드시 고장으로 남긴다.

## 영향 받는 곳 (읽기만 하는 표시)
- apps/cloud/src/learningPipelineStage.ts (판정)
- apps/mobile/src/learningFunnelModel.ts (+ 테스트): 화면 문구. 새 코드 `ORDER_LIMIT_REACHED`의 한국어 문구가 필요하다.
- tests/learning-pipeline-stage.test.js, tests/learning-pipeline-alarm.test.js, apps/cloud/src/learningLoopVerdict.test.ts: 기대 값 갱신.
- 경보(learningPipelineAlarm): `ORDER_LIMIT_REACHED`는 경보를 켜지 않도록 정한다. (소유자 결정 필요)

## 바꾸지 않는 것
- 한도 값, 위험 게이트(independentRiskGateway), 주문 흐름, 자본, 권한.
- 어떤 거절도 숨기지 않는다. 숫자(funnel counts)는 /health에 그대로 남는다.

## 위험과 확인할 것
1. 한도가 아닌 이유가 한 건이라도 있으면 고장으로 읽혀야 한다 (회귀 테스트로 고정).
2. `ORDER` 단계가 PASS가 아니므로 `firstBrokenStage`는 그대로 ORDER가 될 수 있다. 판정을 FAILED가 아니라 "대기"로 바꿀지는 별도 결정이다.
3. 모바일 화면 문구와 알림 정책은 소유자가 정한다.

## 소유자 결정이 필요한 것
- 한도 도달을 경보로 알릴지 (제안: 알리지 않음, 화면에만 표시)
- 학습 판정을 FAILED 대신 WAITING으로 바꿀지 (제안: 이번엔 바꾸지 않고 코드 이름만 구분)

## 작업 순서
1. 판정 함수와 테스트 (표시만)
2. 모바일 문구
3. 독립 검토 후 병합, 한가한 서버에서 배포
