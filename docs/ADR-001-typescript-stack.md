# ADR-001: TypeScript across server, web and mobile

- **Status:** Accepted, 29 October 2026
- **Supersedes:** the Spring Boot (Java 21) + Flutter stack in the first draft of the Technical Implementation Blueprint, section 2

## Decision

Build InspectionFlow in TypeScript end to end:

| Layer | Choice |
| --- | --- |
| Violation engine | `packages/engine`, pure TypeScript, no I/O |
| Offline sync | `packages/sync-client` (outbox, idempotent push, pull, provisional evaluation) |
| API | NestJS 10 on Node.js 22, `pg`, zod, jose |
| Database | PostgreSQL 16/17 with row-level security; SQL migrations in `db/migrations` |
| Web | React 18, Vite, Ant Design 5 (RTL) |
| Mobile | Expo SDK 52 / React Native 0.76, expo-sqlite with SQLCipher, SecureStore |
| Workflow | Approval chain and tasks as an explicit state machine in the API |
| Tests | Vitest, Jest + Supertest on a real PostgreSQL, Playwright |

## Reasons

1. **One engine, two places.** The violation engine must give the same answer offline on the device (provisional) and on the server (authoritative). One TypeScript package used by both removes the risk of two implementations drifting apart.
2. **One language for a small team.** About ten engineers cover API, web and mobile without splitting into Java, Dart and TypeScript specialists.
3. **Familiar structure.** NestJS modules, dependency injection and guards map closely to Spring concepts, so Java-experienced staff can review and maintain it.
4. **Continuity.** The legacy Tafteesh app is React Native; that experience carries over.

## Consequences

- Oracle support (Sovereign edition) needs a repository layer with Oracle-specific SQL instead of JPA; it remains planned, not built.
- No embedded BPMN engine. If tenants must design new flows themselves, add Camunda 8 or Flowable as a separate service behind the existing approvals and tasks model.
- The mobile app needs a development build (not Expo Go) because of SQLCipher.
- Security scanning, SBOM and dependency policy follow the npm ecosystem (lockfiles committed; `npm audit` and SCA in CI).
